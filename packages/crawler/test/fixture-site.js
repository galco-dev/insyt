// A tiny in-process test site imitating a WordPress salon with GTM + GA4 +
// a legacy UA tag and a WhatsApp booking link. Used by the e2e test.
const http = require('http');

const PAGES = {
  '/': `<!doctype html><html><head>
    <meta name="generator" content="WordPress 6.4">
    <script async src="https://www.googletagmanager.com/gtm.js?id=GTM-TEST123"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('config', 'G-FIXTURE001');
      ga('create', 'UA-99887766-1', 'auto'); // legacy debris
    </script>
    <link rel="stylesheet" href="/wp-content/themes/salon/style.css">
    </head><body>
    <nav>
      <a href="/contact">Contact</a>
      <a href="/services">Services</a>
      <a href="/booking">Book</a>
      <a href="/secret-admin">Admin</a>
      <a href="/about">About us</a>
    </nav>
    <a href="https://wa.me/97150000000">WhatsApp us</a>
    </body></html>`,
  '/contact': `<!doctype html><html><head>
    <script async src="https://www.googletagmanager.com/gtm.js?id=GTM-TEST123"></script>
    </head><body><h1>Contact</h1></body></html>`,
  '/services': `<!doctype html><html><head></head><body><h1>Services — no tag here (coverage gap)</h1></body></html>`,
  '/booking': `<!doctype html><html><head>
    <script>gtag('config', 'G-FIXTURE001');</script>
    </head><body><h1>Book</h1></body></html>`,
  '/robots.txt': `User-agent: *\nDisallow: /secret-admin\n`,
};

function startFixture(port = 0) {
  const server = http.createServer((req, res) => {
    const body = PAGES[req.url.split('?')[0]];
    if (!body) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': req.url === '/robots.txt' ? 'text/plain' : 'text/html' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { startFixture };
