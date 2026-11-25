
## v2.2.6
- Fixed the live character / word / approximate-token counter being hidden on browser widths under 720px.
- On narrow windows the counter now moves to a second row in the floating toolbar instead of disappearing.

# ChatGPT RTL/LTR Helper Pro v2.2.2

افزونه‌ی سبک Manifest V3 برای بهتر کردن تجربه‌ی فارسی/انگلیسی در ChatGPT، بدون ارسال داده به سرور خارجی.

## امکانات

- تشخیص خودکار RTL/LTR هنگام تایپ
- سه حالت Auto / RTL / LTR
- تشخیص جهت هر پاراگراف Prompt به‌صورت مستقل
- راست‌چین/چپ‌چین خودکار پیام‌ها
- Code Blockهای همیشه LTR + دکمه Copy
- ذخیره و بازیابی Draft بعد از Refresh
- شمارنده Character / Word / Token تقریبی
- انتخاب فونت، اندازه متن و عرض چت
- Export / Import تنظیمات
- نوار شناور شیشه‌ای
- **پنل ابزار متن داخل صفحه**:
  - اصلاح محافظه‌کارانه نیم‌فاصله برای `می/نمی` و پسوندهای رایج
  - تبدیل `ي/ك` عربی به `ی/ک` فارسی
  - تبدیل و مرتب‌سازی علائم فارسی در متن فارسی
  - تبدیل اعداد فارسی/انگلیسی
  - Copy Prompt as Markdown
- **Focus Mode** برای مخفی‌کردن Sidebar و خلوت‌کردن محیط
- بدون API خارجی و Analytics

## میانبرها

- `Alt + Shift + A` → Auto
- `Alt + Shift + R` → RTL
- `Alt + Shift + L` → LTR
- `Alt + Shift + T` → باز/بسته کردن ابزار متن
- `Alt + Shift + F` → Focus Mode

## نکته‌ها

- Token Counter تقریبی است و از `chars / 4` استفاده می‌کند.
- تبدیل نیم‌فاصله عمداً محافظه‌کارانه است تا متن یا کد را بی‌جهت دستکاری نکند.
- Focus Mode فقط Sidebarهای شناخته‌شده را مخفی می‌کند؛ اگر UI خود ChatGPT عوض شود ممکن است selector آن نیاز به آپدیت داشته باشد.
- فونت Vazirmatn/IRANSans فقط در صورتی نمایش داده می‌شود که روی سیستم نصب باشد.

## نصب / آپدیت

1. ZIP را Extract کنید.
2. Chrome → `chrome://extensions`
3. Developer mode را روشن کنید.
4. `Load unpacked` → پوشه `chatgpt-direction-helper-v2.2`
5. یک‌بار صفحه ChatGPT را Refresh کنید.

## حریم خصوصی

تنظیمات در `chrome.storage.sync` و Draftها در `chrome.storage.local` ذخیره می‌شوند. هیچ داده‌ای به سرور دیگری ارسال نمی‌شود.


## v2.2.6 performance fix
- Removed the 300ms polling counter loop.
- Stopped duplicate keyup/beforeinput work on every keystroke.
- Ignores MutationObserver churn inside the active composer.
- Counter and direction updates are batched with requestAnimationFrame.
- Per-paragraph direction is debounced while typing.
- Uses textContent instead of innerText in the hot path to avoid forced layout.

## v2.3.1
- Added a Work / Codex Usage card in the extension popup.
- Shows available 5-hour and weekly windows, remaining percentage, used percentage, and reset countdown.
- Reads usage only when the popup opens or when Refresh is pressed; no polling and no changes to the ChatGPT page DOM.
- The ChatGPT access token is kept only in memory for the request and is never stored by the extension.
- Usage data comes from ChatGPT's internal `/backend-api/wham/usage` endpoint, which is not a public API and may change.
