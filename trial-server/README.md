# Trial server — Render free (chỉ thử 1 chức năng)

Máy chủ thử nghiệm cho **riêng chức năng "user dán link YouTube → bài học
Shadowing"**, sau khi deploy Firebase bị chặn (project `donghung-3208d`
chưa gắn billing; Google giờ bắt buộc có billing mới deploy được Cloud
Functions, kể cả gen 1 miễn phí).

- **Không phải cả app.** App vẫn ở GitHub Pages như cũ. Chỉ thử riêng
  function này trên Render free; nếu thử OK mới tính chuyện chuyển cả app.
- **Không sửa code Firebase.** `functions/` giữ nguyên. Server này chỉ
  `require('../functions/src/pipeline.js')` và chạy `buildLessonFree` — đúng
  pipeline mà function Firebase sẽ chạy.
- **Không cần thẻ thanh toán.** Render free không đòi billing.

## Chạy local

```sh
cd trial-server
npm install
npm start            # PORT mặc định 3000
curl localhost:3000/health
curl -X POST localhost:3000/makeLesson \
  -H 'Content-Type: application/json' \
  -d '{"videoId":"mKPRQF70PvA"}'
```

Test tự động (không cần YouTube live — dùng fixture phụ đề có sẵn):

```sh
npm test   # node test-local.js
```

## Deploy tay lên Render (dashboard, không cần render.yaml cũng được)

Chuẩn bị: push thư mục `sorakanji-backend/` lên một GitHub repo (private
cũng được) — Render deploy từ GitHub, và cần cả thư mục `functions/`
vì server require pipeline từ đó.

1. Render dashboard → **New → Web Service** → chọn repo vừa push.
2. **Root Directory:** `trial-server`
3. **Runtime:** Node — **Build Command:** xem `render.yaml`
   (`npm install && (cd ../functions && npm install --legacy-peer-deps)`)
4. **Start Command:** `node server.js`
5. **Instance Type:** Free.
6. Deploy xong, kiểm tra:
   ```sh
   curl https://<ten-service>.onrender.com/health
   curl -X POST https://<ten-service>.onrender.com/makeLesson \
     -H 'Content-Type: application/json' \
     -d '{"url":"https://www.youtube.com/shorts/mKPRQF70PvA"}'
   ```
   Bài trả về phải có đủ `lines[]` (mỗi câu có `jp`, `reading`, `romaji`,
   `tokens`) và `meta.translationStatus`. Lần gọi đầu tiên sẽ chậm
   (~vài giây) vì kuromoji build tokenizer lần đầu; các lần sau nhanh hơn.
   Lưu ý: Render free **ngủ sau 15 phút không có traffic** — request đầu
   sau khi ngủ mất ~30–60 giây để đánh thức.

## Giới hạn đã biết

- **RAM free 512 MB, kuromoji ngốn ~400 MB lúc build tokenizer lần đầu.**
  Đo local xem `test-local.js` báo peak RSS bao nhiêu — nếu sát 512 MB thì
  trên Render có nguy cơ bị kill lúc request đầu tiên (xem log Render).
- **Đầu dịch free (translate.googleapis.com) có thể bị 429** — đã bị chặn
  từ IP máy test ngày 2026-11-11. Pipeline đã xử lý: vẫn trả bài đủ câu
  Nhật + furigana, phần dịch để trống (`vi: null`,
  `meta.translationStatus: "unavailable"`). Chỉ kiểm chứng được đầu dịch
  có chạy trên IP Render không sau khi deploy.
- **Lấy caption live từ YouTube cũng vậy** — từ máy test đang bị chặn 429;
  IP Render khác nên phải test live sau deploy mới biết.
- **CORS mở (`*`), không có auth** — chỉ là máy thử nghiệm. Nếu chuyển
  thật, phải gắn giới hạn (rate limit / key / đăng nhập) trước khi cho
  người học dùng.
