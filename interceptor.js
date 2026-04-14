import http from 'http';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    console.log(`[${req.method}] ${req.url}`);
    console.log(JSON.stringify(req.headers, null, 2));
    if (body) {
      try { console.log(JSON.stringify(JSON.parse(body), null, 2)); }
      catch(e) { console.log(body); }
    }
    
    // Return a fake Anthropic error to see how Claude Code reacts
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "Intercepted!" }
    }));
  });
});

server.listen(8000, () => console.log('Interceptor listening on 8000'));
