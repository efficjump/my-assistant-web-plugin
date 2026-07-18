const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const port = Number(process.env.PORT || 4173);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

http.createServer((request, response) => {
  if (request.url === "/mock-ai") {
    response.writeHead(404).end();
    return;
  }
  const requestPath = request.url === "/" ? "/panel.html" : new URL(request.url, `http://127.0.0.1:${port}`).pathname;
  const absolutePath = path.resolve(root, `.${requestPath}`);
  if (!absolutePath.startsWith(root) || !fs.existsSync(absolutePath) || fs.statSync(absolutePath).isDirectory()) {
    response.writeHead(404).end("Not found");
    return;
  }
  let body = fs.readFileSync(absolutePath);
  if (requestPath === "/panel.html") {
    body = Buffer.from(body.toString("utf8").replace(
      '<script src="agent-core.js"></script>',
      '<script src="tests/chrome-mock.js"></script>\n    <script src="agent-core.js"></script>'
    ));
  }
  response.writeHead(200, {
    "Content-Type": mimeTypes[path.extname(absolutePath)] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  response.end(body);
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`Agent panel harness: http://127.0.0.1:${port}/panel.html\n`);
});
