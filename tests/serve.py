# Статический сервер без кэша для tests/*.html.
# POST /save/<имя> сохраняет тело в tests/out/<имя> (нужно для проверки конфигов настоящим sing-box).
import http.server, functools, os, sys, re
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
outdir = os.path.join(root, 'tests', 'out')
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def do_POST(self):
        m = re.fullmatch(r'/save/([\w.-]+)', self.path)
        if not m:
            self.send_error(404); return
        os.makedirs(outdir, exist_ok=True)
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        with open(os.path.join(outdir, m.group(1)), 'wb') as f:
            f.write(body)
        self.send_response(204); self.end_headers()
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), functools.partial(H, directory=root)).serve_forever()
