"use strict";

/**
 * 대시보드 통계 도메인.
 * 전 직원이 프로젝트/마감을 본다. 청구(미수금·연체)는 청구권자(치프/대표), 클라이언트 수는 치프에게 노출.
 * data.js에서 분리한 모듈(도메인 모듈화). data.js가 재export하므로 소비자 무변경.
 * cross-domain: invoiceStats(invoices)를 직접 require(무순환 — invoices는 dashboard를 호출하지 않음).
 */

const { db } = require("../db");
const { canInvoice, isChief } = require("../auth");
const { invoiceStats } = require("./invoices"); // 무순환

function dashboardStats(user) {
  const d = db();
  const total = d.prepare("SELECT COUNT(*) AS n FROM projects").get().n;
  const showInvoices = canInvoice(user);
  const showClients = isChief(user);
  return {
    canInvoice: showInvoices,
    isChief: showClients,
    total,
    clients: showClients ? d.prepare("SELECT COUNT(*) AS n FROM clients").get().n : null,
    invoices: showInvoices ? invoiceStats(user) : null,
  };
}

module.exports = {
  dashboardStats,
};
