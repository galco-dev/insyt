// Unauthed pages — §11 screens 1 and 3. §18 tokens, §4 register, one action.
// Copy inline here is customer-facing: keep it inside the linter's reach by
// mirroring any new strings into packages/emails/copy.json if they grow.

const FONT = "'Geist', Helvetica, Arial, sans-serif";
const ACCENT = '#000d14';

const head = (title) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
<style>
body{margin:0;font-family:${FONT};background:#fff;color:${ACCENT};} .wrap{max-width:560px;margin:0 auto;padding:64px 20px;text-align:center;}
input{font-family:${FONT};font-size:16px;padding:12px 16px;border:1px solid #d1d1d1;border-radius:6px;width:100%;box-sizing:border-box;}
button{font-family:${FONT};font-size:14px;font-weight:500;background:${ACCENT};color:#fff;border:0;border-radius:6px;padding:12px 24px;margin-top:12px;cursor:pointer;width:100%;}
.sub{color:#727272;font-size:14px;} a{color:#727272;}
</style>

<meta name="facebook-domain-verification" content="sxlwbu0v4rf3rm7yofkgnr9l5xowdn" />
</head>

<body>`;

function landingPage() {
  return `${head('Insyt — your ads, watched and fixed every week')}
<div class="wrap">
  <h1 style="font-size:32px;font-weight:600;margin:0 0 8px 0;">Your Google Ads, watched and fixed every week.</h1>
  <p class="sub">Paste your website. Get a free check in 3 minutes.</p>
  <form onsubmit="go(event)">
    <input id="url" placeholder="yourwebsite.com" autocomplete="url" required>
    <button>Check my website — free</button>
  </form>
  <p class="sub" style="margin-top:24px;">We only ever get read access until you approve a fix — and you can see <a href="/sample">an example report</a> before connecting anything.</p>
</div>
<script>
async function go(e){e.preventDefault();
  const r=await fetch('/api/crawl',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:document.getElementById('url').value})});
  const b=await r.json();
  if(r.ok){location.href='/check/'+b.id}else{alert(b.error)}
}
</script></body></html>`;
}

function progressPage(crawlId) {
  return `${head('Checking your website…')}
<div class="wrap">
  <h1 style="font-size:24px;font-weight:600;">Checking your website…</h1>
  <p class="sub" id="line">Reading your pages…</p>
  <div id="strip" style="text-align:left;margin-top:24px;"></div>
</div>
<script>
const id=${JSON.stringify(crawlId)};
async function poll(){
  const r=await fetch('/api/crawl/'+id); const b=await r.json();
  if(b.status==='complete'&&b.strip){
    document.getElementById('line').textContent=b.strip.headline;
    document.getElementById('strip').innerHTML=b.strip.items.map(i=>'<p style="border:1px solid #e6e6e6;border-radius:6px;padding:10px 14px;">'+i+'</p>').join('');
  } else if(b.status==='failed'){
    document.getElementById('line').textContent="We couldn't reach your website.";
  } else { setTimeout(poll,1500); }
}
poll();
</script>
</body>
</html>`;
}

module.exports = { landingPage, progressPage };
