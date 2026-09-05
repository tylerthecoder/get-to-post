const $ = (id) => document.getElementById(id);
const fields = ['destination', 'data', 'headers', 'response', 'timeout'];
let generated = '';
let curl = '';
let pending = false;
function update() {
  try {
    const destination = new URL($('destination').value);
    if (destination.protocol !== 'https:' || destination.username || destination.password || destination.hash || (destination.port && destination.port !== '443')) throw new Error('Use an HTTPS URL on port 443 without embedded credentials or a fragment.');
    const headers = JSON.parse($('headers').value || '{}');
    if (!headers || Array.isArray(headers) || typeof headers !== 'object' || Object.values(headers).some((v) => typeof v !== 'string')) throw new Error('Headers must be a JSON object with string values.');
    const timeout = Number($('timeout').value);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 20000) throw new Error('Timeout must be between 1 and 20000 milliseconds.');
    const params = new URLSearchParams({ url: destination.href, data: $('data').value, headers: JSON.stringify(headers), response: $('response').value, timeout: String(timeout) });
    const relative = `/api/post?${params}`;
    if (new TextEncoder().encode(relative).length > 12288) throw new Error('The encoded URL exceeds 12 KiB. Reduce the body or headers.');
    generated = `${location.origin}${relative}`;
    const shellQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
    curl = `curl --get ${shellQuote(`${location.origin}/api/post`)} \\\n` + Array.from(params, ([k, v]) => `  --data-urlencode ${shellQuote(`${k}=${v}`)}`).join(' \\\n');
    $('generated-url').textContent = generated;
    $('generated-curl').textContent = curl;
    $('send').disabled = pending;
    $('copy-url').disabled = false;
    $('copy-curl').disabled = false;
    $('builder-status').textContent = '';
    return true;
  } catch (error) {
    generated = ''; curl = '';
    $('generated-url').textContent = 'Complete the request fields to generate a URL.';
    $('generated-curl').textContent = '—';
    $('builder-status').textContent = error.message;
    $('send').disabled = true; $('copy-url').disabled = true; $('copy-curl').disabled = true;
    return false;
  }
}
fields.forEach((id) => $(id).addEventListener('input', update));
for (const [id, content] of [['copy-url', () => generated], ['copy-curl', () => curl]]) {
  $(id).addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(content()); $('builder-status').textContent = 'Copied to clipboard.'; }
    catch { $('builder-status').textContent = 'Clipboard unavailable. Select and copy the text above.'; }
  });
}
$('send').addEventListener('click', async () => {
  if (pending || !update()) return;
  const requestUrl = generated;
  pending = true; $('send').disabled = true; $('builder-status').textContent = 'Sending POST through the converter…';
  const start = performance.now();
  $('result-section').hidden = false; $('result').textContent = 'Waiting for response…'; $('result-status').textContent = '';
  try {
    const response = await fetch(requestUrl, { cache: 'no-store', credentials: 'omit', redirect: 'manual' });
    if (response.type === 'opaqueredirect') {
      $('result-status').textContent = 'Upstream redirect';
      $('result').textContent = 'The destination returned a redirect. No redirect was followed. Select the JSON response format to inspect the status, Location header, and body.';
    } else {
      $('result-status').textContent = `HTTP ${response.status} · ${Math.round(performance.now() - start)} ms`;
      if ((response.headers.get('content-type') ?? '').includes('application/octet-stream')) {
        const body = await response.arrayBuffer();
        $('result').textContent = `Binary response (${body.byteLength} bytes). Select JSON response format to see the base64-encoded body.`;
      } else {
        const text = await response.text();
        try { $('result').textContent = JSON.stringify(JSON.parse(text), null, 2); }
        catch { $('result').textContent = text || '(empty body)'; }
      }
    }
    $('builder-status').textContent = 'Request complete. Sending again will make another POST.';
  } catch {
    $('result').textContent = 'Could not read the response. The POST may already have been sent; do not retry blindly.';
    $('builder-status').textContent = 'Request failed.';
  } finally { pending = false; $('send').disabled = !generated; }
});
$('js-example').textContent = `const params = new URLSearchParams({
  url: "https://httpbin.org/post",
  data: JSON.stringify({ message: "Hello" }),
  headers: JSON.stringify({ "Content-Type": "application/json" }),
  response: "json"
});

const response = await fetch(\`${location.origin}/api/post?\${params}\`);
const result = await response.json();
// result.status is the upstream status; result.body is its response.
console.log(result);`;
update();
