"use strict";

/**
 * async 라우트 핸들러 래퍼. Express 4는 async 함수의 reject를 자동으로 잡지 못해
 * (전역 에러 핸들러로 가지 않고) 요청이 멈춘다. 이 래퍼가 reject를 next(err)로 전달한다.
 */
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
