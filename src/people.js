"use strict";

/**
 * Google People API 연동 모듈 — 앱→Google push(단방향).
 *
 * 목적: contacts 생성/수정/삭제 시 Google 연락처에 반영.
 *       역방향(Google→앱)은 다음 단계 — 이 모듈에서는 앱 발생 변경만 push.
 *
 * 설계(calendar.js와 동일 패턴):
 * - 관리자(치프) OAuth refresh token을 재사용(drive.getRefreshToken), scope 'contacts' 필요.
 * - 미연동/권한없음/네트워크 오류는 fail-safe(null/void) — 연락처 CRUD 자체는 마비되지 않는다.
 */

const { google } = require("googleapis");
const { config } = require("./config");
const { oauthClient } = require("./auth");
const { getRefreshToken } = require("./drive");

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

module.exports = { peopleClient, personBodyFromContact, createPerson, updatePerson, deletePerson };
