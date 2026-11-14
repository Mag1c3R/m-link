# Тестовый сервер для tests/*.html (без кэша).
#
#   POST /save/<имя>          — сохраняет тело запроса в tests/out/<имя>
#   GET  /fake-sub            — отдаёт подписку с заголовками панели: tests/out/sub.txt, если он есть,
#                               иначе маленькую тестовую. /fake-sub-ua — User-Agent последнего запроса.
#   POST /fake-freeze?fmt=X   — «замораживает» /fake-sub: X = xray | links | empty; без fmt — размораживает.
#
# Мост к настоящему помощнику для tests/e2e.html (заменяет chrome.runtime.connectNative):
#   POST /native/open         — запускает помощник, отвечает {"id": n}
#   POST /native/<id>/send    — передаёт помощнику JSON-сообщение
#   GET  /native/<id>/recv    — ждёт сообщения от помощника, отвечает JSON-массивом; 410, если он завершился
#   POST /native/<id>/close   — закрывает помощник
#
# Переменные окружения: MLINK_HELPER — путь к помощнику, MLINK_TEST_HOME — его домашняя папка.
import base64, functools, http.server, json, os, platform, queue, re, struct, subprocess, sys, threading

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
outdir = os.path.join(root, 'tests', 'out')

def default_helper():
    system = {'Darwin': 'darwin', 'Linux': 'linux'}.get(platform.system(), 'windows')
    arch = 'arm64' if platform.machine().lower() in ('arm64', 'aarch64') else 'amd64'
    exe = 'm-link-helper.exe' if system == 'windows' else 'm-link-helper'
    return os.path.join(root, 'helper', 'dist', f'm-link-helper-{system}-{arch}', exe)

HELPER = os.environ.get('MLINK_HELPER') or default_helper()
sessions = {}
state = {'next': 1, 'ua': '', 'frozen': ''}
lock = threading.Lock()

class Session:
    def __init__(self):
        env = dict(os.environ)
        if os.environ.get('MLINK_TEST_HOME'):
            env['HOME'] = os.environ['MLINK_TEST_HOME']
        self.proc = subprocess.Popen([HELPER, 'chrome-extension://e2e/'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
        self.q = queue.Queue()
        self.done = False
        threading.Thread(target=self.reader, daemon=True).start()

    def reader(self):
        out = self.proc.stdout
        while True:
            hdr = out.read(4)
            if len(hdr) < 4:
                break
            self.q.put(out.read(struct.unpack('<I', hdr)[0]).decode('utf-8'))
        self.q.put(None)

    def send(self, raw):
        self.proc.stdin.write(struct.pack('<I', len(raw)) + raw)
        self.proc.stdin.flush()

    def recv(self):
        if self.done:
            return None
        items = []
        try:
            first = self.q.get(timeout=20)
        except queue.Empty:
            return items
        while True:
            if first is None:
                self.done = True
                return items or None
            items.append(first)
            try:
                first = self.q.get_nowait()
            except queue.Empty:
                return items

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass

SMALL_SUB = '\n'.join([
    'vless://11111111-2222-3333-4444-555555555555@192.0.2.1:443?security=reality&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&sid=ab&sni=example.com&flow=xtls-rprx-vision#Test VLESS',
    'hy2://pass@192.0.2.2:443?sni=example.com#Test Hy2',
    'vless://11111111-2222-3333-4444-555555555555@192.0.2.3:443?security=tls&type=xhttp#Test XHTTP',
]).encode()

# Как панели отвечают на замороженную подписку: сообщение вместо серверов.
FROZEN = {
    'xray': json.dumps([
        {'remarks': '⛔ Подписка заморожена', 'outbounds': [{'protocol': 'blackhole', 'tag': 'block'}]},
        {'remarks': '👉 Разморозить: @mag1c3r_vpn_bot', 'outbounds': [{'protocol': 'vless', 'tag': 'proxy', 'settings': {'vnext': [{'address': '0.0.0.0', 'port': 1, 'users': [{'id': '00000000-0000-0000-0000-000000000000'}]}]}}]},
    ], ensure_ascii=False).encode(),
    'links': base64.b64encode('\n'.join([
        'vless://00000000-0000-0000-0000-000000000000@0.0.0.0:1?type=tcp#⛔ Подписка заморожена',
        'vless://00000000-0000-0000-0000-000000000000@0.0.0.0:1?type=tcp#👉 Разморозить: @mag1c3r_vpn_bot',
    ]).encode()),
    'empty': b'',
}

class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def reply(self, code, body=b'', ctype='application/json', headers=()):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        return self.rfile.read(int(self.headers.get('Content-Length', 0)))

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/fake-sub':
            state['ua'] = self.headers.get('User-Agent', '')
            p = os.path.join(outdir, 'sub.txt')
            data = open(p, 'rb').read() if os.path.exists(p) else SMALL_SUB
            data = FROZEN.get(state['frozen'], data)
            return self.reply(200, data, 'text/plain; charset=utf-8', [
                ('Profile-Title', 'base64:' + base64.b64encode('Тестовая подписка'.encode()).decode()),
                ('Subscription-Userinfo', 'upload=1073741824; download=5368709120; total=107374182400; expire=1830297600'),
                ('Profile-Update-Interval', '3'),
                ('Announce', 'base64:' + base64.b64encode('⚠️ Тестовое объявление панели'.encode()).decode()),
            ])
        if path == '/fake-sub-ua':
            return self.reply(200, state['ua'].encode(), 'text/plain; charset=utf-8')
        m = re.fullmatch(r'/native/(\d+)/recv', path)
        if m:
            s = sessions.get(int(m.group(1)))
            items = s.recv() if s else None
            if items is None:
                return self.reply(410)
            return self.reply(200, ('[' + ','.join(items) + ']').encode())
        return super().do_GET()

    def do_POST(self):
        path = self.path.split('?')[0]
        m = re.fullmatch(r'/save/([\w.-]+)', path)
        if m:
            os.makedirs(outdir, exist_ok=True)
            with open(os.path.join(outdir, m.group(1)), 'wb') as f:
                f.write(self.body())
            return self.reply(204)
        if path == '/fake-freeze':
            q = self.path.split('?', 1)[1] if '?' in self.path else ''
            state['frozen'] = dict(x.split('=', 1) for x in q.split('&') if '=' in x).get('fmt', '')
            return self.reply(204)
        if path == '/native/open':
            if not os.path.exists(HELPER):
                return self.reply(404, json.dumps({'error': 'helper not built: ' + HELPER}).encode())
            with lock:
                sid = state['next']
                state['next'] += 1
            sessions[sid] = Session()
            return self.reply(200, json.dumps({'id': sid}).encode())
        m = re.fullmatch(r'/native/(\d+)/(send|close)', path)
        if m and int(m.group(1)) in sessions:
            s = sessions[int(m.group(1))]
            if m.group(2) == 'send':
                try:
                    s.send(self.body())
                except OSError:
                    return self.reply(410)
            else:
                s.close()
            return self.reply(204)
        self.send_error(404)

http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), functools.partial(H, directory=root)).serve_forever()
