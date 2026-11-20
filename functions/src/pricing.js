'use strict';
/**
 * pricing.js — bảng giá Premium SoraKanji theo thời điểm tạo đơn.
 *
 * Pure module (không require firebase) để activateOrder kiểm tra
 * order.amount có khớp giá thật tại lúc đơn được tạo hay không (vá B-1:
 * đơn tự khai giá rẻ — vd Lifetime 1.000đ — không được kích hoạt Premium).
 *
 * Lịch sử giá (VND):
 *   Năm      : 499.000đ trước 2026-11-19T12:52:00Z,
 *              360.000đ trong đợt giảm giá,
 *              799.000đ sau khi hết giảm giá.
 *   Trọn đời : 999.000đ trong đợt giảm giá (chưa từng đổi giá trước đó),
 *              2.499.000đ sau khi hết giảm giá.
 */

// Mốc đổi giá Năm 499.000đ -> 360.000đ (bắt đầu đợt giảm giá).
const YEAR_PRICE_CHANGE_MS = Date.parse('2026-11-19T12:52:00Z');

// Mốc hết giảm giá: 2026-12-06 23:59:59+07:00 = 2026-12-06T16:59:59Z.
// Nguồn sự thật: hằng SK_SALE_END trong client (mobile/web).
const SALE_END_MS = Date.parse('2026-12-06T16:59:59Z');

const PRICE = {
  year: { beforeChange: 499000, sale: 360000, afterSale: 799000 },
  lifetime: { sale: 999000, afterSale: 2499000 },
};

/**
 * Số tiền đúng (VND) của gói `pkg` tại thời điểm `createdAtMs` (millis).
 * Mốc cắt dùng so sánh `<` nghiêm ngặt: đúng tại mốc thì thuộc mức giá mới.
 * Trả null nếu pkg không phải 'year'/'lifetime' (caller đã kiểm package
 * trước khi gọi hàm này).
 */
function expectedPrice(pkg, createdAtMs) {
  if (pkg === 'year') {
    if (createdAtMs < YEAR_PRICE_CHANGE_MS) return PRICE.year.beforeChange;
    if (createdAtMs < SALE_END_MS) return PRICE.year.sale;
    return PRICE.year.afterSale;
  }
  if (pkg === 'lifetime') {
    if (createdAtMs < SALE_END_MS) return PRICE.lifetime.sale;
    return PRICE.lifetime.afterSale;
  }
  return null;
}

/**
 * Parse createdAt về millis. Chấp nhận:
 *   - Firestore Timestamp (có toMillis())
 *   - { seconds, nanoseconds } (dạng JSON của Timestamp)
 *   - Date, number (millis), string ISO
 * Trả null nếu không parse được (caller fallback sang Date.now()).
 */
function toMillis(ts) {
  if (ts === null || ts === undefined) return null;

  if (typeof ts.toMillis === 'function') {
    const ms = ts.toMillis();
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
  }
  if (typeof ts === 'object' && typeof ts.seconds === 'number') {
    const ns = typeof ts.nanoseconds === 'number' ? ts.nanoseconds : 0;
    const ms = ts.seconds * 1000 + ns / 1e6;
    return Number.isFinite(ms) ? ms : null;
  }
  if (ts instanceof Date) {
    const ms = ts.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof ts === 'number') {
    return Number.isFinite(ts) ? ts : null;
  }
  if (typeof ts === 'string') {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

module.exports = { expectedPrice, toMillis, YEAR_PRICE_CHANGE_MS, SALE_END_MS };
