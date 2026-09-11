// Keep request state out of analytics before loading Vercel's tracking script.
window.va = window.va || function () {
  (window.vaq = window.vaq || []).push(arguments);
};
window.va('beforeSend', (event) => {
  const url = new URL(event.url);
  url.search = '';
  url.hash = '';
  return { ...event, url: url.toString() };
});

const script = document.createElement('script');
script.defer = true;
script.src = '/_vercel/insights/script.js';
document.head.appendChild(script);
