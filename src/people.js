"use strict";

/**
 * Google People API 연동 모듈 — 앱↔Google 양방향.
 *
 * 목적:
 *   - 앱→Google push: contacts 생성/수정/삭제 시 Google 연락처에 반영.
 *   - Google→앱 pull(syncFromGoogle): syncToken 증분 폴링으로 변경 수신.
 *
 * 설계(calendar.js와 동일 패턴):
 * - 관리자(치프) OAuth refresh token을 재사용(drive.getRefreshToken), scope 'contacts' 필요.
 * - 미연동/권한없음/네트워크 오류는 fail-safe(null/void) — 연락처 CRUD 자체는 마비되지 않는다.
 * - 루프 방지: syncFromGoogle은 data.js 헬퍼를 직접 호출(contacts.routes 훅을 거치지 않아 re-push 없음).
 */

const { google } = require("googleapis");
const { config } = require("./config");
const { oauthClient } = require("./auth");
const { getRefreshToken } = require("./drive");
const { getState, setState } = require("./db");
const {
  getContactByResourceName,
  createContact,
  updateContact,
  deleteContact,
  setContactGoogleRef,
} = require("./data");

/** refresh token으로 인증된 People 클라이언트. 미연동이면 null. */
function peopleClient() {
  const refresh = getRefreshToken();
  if (!config.googleConfigured || !refresh) return null;
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: refresh });
  return google.people({ version: "v1", auth });
}

/**
 * contacts 행 → People API requestBody 매핑.
 * 빈 값은 해당 필드 자체를 생략(API가 빈 배열을 거부하지 않도록 방어).
 */
function personBodyFromContact(c) {
  const body = {};

  const nameFields = {};
  if (c.given_name) nameFields.givenName = c.given_name;
  if (c.family_name) nameFields.familyName = c.family_name;
  if (c.honorific) nameFields.honorificPrefix = c.honorific;
  if (Object.keys(nameFields).length) body.names = [nameFields];

  if (c.nickname) body.nicknames = [{ value: c.nickname }];

  const orgFields = {};
  if (c.company) orgFields.name = c.company;
  if (c.job_title) orgFields.title = c.job_title;
  if (c.department) orgFields.department = c.department;
  if (Object.keys(orgFields).length) body.organizations = [orgFields];

  if (c.phone) body.phoneNumbers = [{ value: c.phone }];
  if (c.email) body.emailAddresses = [{ value: c.email }];

  return body;
}

/** Google People에 새 연락처 생성. 실패 시 null. */
async function createPerson(contact) {
  const people = peopleClient();
  if (!people) return null;
  try {
    const requestBody = personBodyFromContact(contact);
    const { data } = await people.people.createContact({ requestBody });
    return { resourceName: data.resourceName, etag: data.etag };
  } catch (_e) {
    return null;
  }
}

/**
 * Google People 연락처 수정.
 * etag 충돌(4xx) 시 최신 etag 조회 후 1회 재시도.
 * 실패 시 null.
 */
async function updatePerson(resourceName, etag, contact) {
  const people = peopleClient();
  if (!people) return null;

  async function attempt(currentEtag) {
    const requestBody = { etag: currentEtag, ...personBodyFromContact(contact) };
    const { data } = await people.people.updateContact({
      resourceName,
      updatePersonFields: "names,nicknames,organizations,phoneNumbers,emailAddresses",
      requestBody,
    });
    return { etag: data.etag };
  }

  try {
    return await attempt(etag);
  } catch (e) {
    const code = e.code || (e.response && e.response.status);
    if (code >= 400 && code < 500) {
      // etag 충돌 추정 — 최신 etag 조회 후 1회 재시도
      try {
        const { data: meta } = await people.people.get({ resourceName, personFields: "metadata" });
        return await attempt(meta.etag);
      } catch (_e2) {
        return null;
      }
    }
    return null;
  }
}

/** Google People 연락처 삭제. fail-safe(오류 흡수). */
async function deletePerson(resourceName) {
  const people = peopleClient();
  if (!people || !resourceName) return;
  try {
    await people.people.deleteContact({ resourceName });
  } catch (_e) {
    // fail-safe
  }
}

/**
 * People person 응답 → contacts 필드 역매핑.
 * personBodyFromContact의 역방향.
 */
function personToContactFields(person) {
  const out = {};

  const nameEntry = (person.names || [])[0] || {};
  if (nameEntry.familyName) out.family_name = nameEntry.familyName;
  if (nameEntry.givenName) out.given_name = nameEntry.givenName;
  if (nameEntry.honorificPrefix) out.honorific = nameEntry.honorificPrefix;
  // displayName을 표시명(name)으로 사용. 없으면 resolveContactName이 parts에서 조합.
  if (nameEntry.displayName) out.name = nameEntry.displayName;

  const nickEntry = (person.nicknames || [])[0];
  if (nickEntry && nickEntry.value) out.nickname = nickEntry.value;

  const orgEntry = (person.organizations || [])[0] || {};
  if (orgEntry.name) out.company = orgEntry.name;
  if (orgEntry.title) out.job_title = orgEntry.title;
  if (orgEntry.department) out.department = orgEntry.department;

  const phoneEntry = (person.phoneNumbers || [])[0];
  if (phoneEntry && phoneEntry.value) out.phone = phoneEntry.value;

  const emailEntry = (person.emailAddresses || [])[0];
  if (emailEntry && emailEntry.value) out.email = emailEntry.value;

  return out;
}

/**
 * Google→앱 역방향 동기화.
 * syncToken 증분 폴링; 만료(410/FAILED_PRECONDITION) 시 full sync 재시도.
 * 루프 방지: data.js 직접 호출 → contacts.routes push 훅을 안 거침.
 *
 * @returns {{ created: number, updated: number, deleted: number }
 *          | { skipped: true }
 *          | { error: string }}
 */
async function syncFromGoogle() {
  const cl = peopleClient();
  if (!cl) return { skipped: true };

  try {
    const syncToken = getState("contacts_sync_token") || undefined;

    /** 전체(syncToken=null) 또는 증분 목록을 pageToken 루프로 수집. */
    async function fetchAll(token) {
      const persons = [];
      let finalSyncToken = null;
      let pageToken = undefined;

      while (true) {
        let resp;
        try {
          resp = await cl.people.connections.list({
            resourceName: "people/me",
            personFields: "names,nicknames,organizations,phoneNumbers,emailAddresses,metadata",
            requestSyncToken: true,
            syncToken: token || undefined,
            pageToken,
            pageSize: 200,
          });
        } catch (e) {
          // syncToken 만료 → full sync 재시도(무한 루프 방지: token이 이미 null이면 재throw)
          const code = e.code || (e.response && e.response.status);
          const msg = String(e.message || "");
          if (token && (code === 410 || msg.includes("FAILED_PRECONDITION"))) {
            return fetchAll(null);
          }
          throw e;
        }

        const data = resp.data;
        if (Array.isArray(data.connections)) persons.push(...data.connections);
        if (data.nextSyncToken) finalSyncToken = data.nextSyncToken;

        if (!data.nextPageToken) break;
        pageToken = data.nextPageToken;
      }

      return { persons, finalSyncToken };
    }

    const { persons, finalSyncToken } = await fetchAll(syncToken);

    let created = 0, updated = 0, deleted = 0;

    for (const person of persons) {
      const resourceName = person.resourceName;
      const etag = person.etag;
      const meta = person.metadata || {};

      if (meta.deleted) {
        const existing = getContactByResourceName(resourceName);
        if (existing) {
          deleteContact(existing.id);
          deleted++;
        }
      } else {
        const fields = personToContactFields(person);
        const existing = getContactByResourceName(resourceName);
        if (existing) {
          try {
            updateContact(existing.id, fields);
            setContactGoogleRef(existing.id, resourceName, etag);
            updated++;
          } catch (_e) {
            // CONTACT_NAME_REQUIRED 등 — 무시하고 계속
          }
        } else {
          // 이름 식별 불가 연락처는 건너뜀
          if (!fields.name && !fields.given_name && !fields.family_name && !fields.nickname) continue;
          try {
            const newId = createContact(fields);
            setContactGoogleRef(newId, resourceName, etag);
            created++;
          } catch (_e) {
            // CONTACT_NAME_REQUIRED 등 — 무시하고 계속
          }
        }
      }
    }

    if (finalSyncToken) setState("contacts_sync_token", finalSyncToken);

    return { created, updated, deleted };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

module.exports = {
  peopleClient,
  personBodyFromContact,
  createPerson,
  updatePerson,
  deletePerson,
  personToContactFields,
  syncFromGoogle,
};
