import os
import time
import socket
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

try:
    import pymysql
except Exception:
    pymysql = None

try:
    import requests
except Exception:
    requests = None

try:
    from apns2.client import APNsClient
    from apns2.payload import Payload
    from apns2.credentials import TokenCredentials
except Exception:
    APNsClient = None
    Payload = None
    TokenCredentials = None

def _env(k, d=None):
    v = os.environ.get(k)
    return v if v is not None and v != '' else d

DB_HOST = _env('DB_HOST', 'srv1571.hstgr.io')
DB_USER = _env('DB_USER', 'u803886834_dev_tify')
DB_PASSWORD = _env('DB_PASSWORD', 'Pop654--.123SD')
DB_NAME = _env('DB_NAME', 'u803886834_dev_tify')
DB_PORT = int(_env('DB_PORT', '3306'))
POLL_INTERVAL = int(_env('EMITTER_POLL_INTERVAL', '15'))
LOOKBACK_SECONDS = int(_env('EMITTER_LOOKBACK_SECONDS', '300'))
WEBHOOK_URL = _env('EMITTER_WEBHOOK_URL')

APNS_AUTH_KEY_PATH = _env('APNS_AUTH_KEY_PATH')
APNS_KEY_ID = _env('APNS_KEY_ID')
APNS_TEAM_ID = _env('APNS_TEAM_ID')
APNS_TOPIC = _env('APNS_TOPIC')
APNS_USE_SANDBOX = _env('APNS_ENV', 'sandbox') == 'sandbox'
DEVICE_TOKENS = [t.strip() for t in (_env('APNS_DEVICE_TOKENS', '') or '').split(',') if t.strip()]
HTTP_PORT = int(_env('EMITTER_HTTP_PORT', '8766'))
BIND_HOST = _env('EMITTER_BIND_HOST', '0.0.0.0')
RECENT_EVENTS = []

def _format_event_date(iso):
    try:
        dt = datetime.fromisoformat(iso.replace('Z', '+00:00'))
    except Exception:
        return None
    days = ['lunes','martes','miércoles','jueves','viernes','sábado','domingo']
    months = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic']
    return f"{days[dt.weekday()]} {dt.day} {months[dt.month-1]}"

def _upsert_event(evt):
    try:
        idx = next((i for i,e in enumerate(RECENT_EVENTS) if e.get('id') == evt.get('id')), None)
    except Exception:
        idx = None
    if idx is None:
        RECENT_EVENTS.append(evt)
    else:
        prev = RECENT_EVENTS[idx]
        new_has = bool(evt.get('eventAt'))
        prev_has = bool(prev.get('eventAt'))
        if new_has and not prev_has:
            RECENT_EVENTS[idx] = evt
        elif (not new_has and prev_has):
            pass
        else:
            RECENT_EVENTS[idx] = evt
    if len(RECENT_EVENTS) > 200:
        RECENT_EVENTS[:] = RECENT_EVENTS[-200:]

def _override_from_database_url(db_url: str):
    try:
        parsed = urlparse(db_url)
        host = parsed.hostname
        port = parsed.port
        user = parsed.username
        password = parsed.password
        db = (parsed.path or '').lstrip('/')
        global DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
        DB_HOST = host or DB_HOST
        DB_PORT = port or DB_PORT
        DB_USER = user or DB_USER
        DB_PASSWORD = password or DB_PASSWORD
        DB_NAME = db or DB_NAME
    except Exception:
        pass

def _load_backend_env():
    env_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '.env'))
    if os.path.exists(env_path):
        try:
            with open(env_path, 'r') as f:
                for raw in f:
                    line = raw.strip()
                    if not line or line.startswith('#'):
                        continue
                    if '=' not in line:
                        continue
                    key, val = line.split('=', 1)
                    val = val.strip().strip('"').strip("'")
                    if key == 'DATABASE_URL':
                        _override_from_database_url(val)
                    elif key == 'EMITTER_WEBHOOK_URL':
                        global WEBHOOK_URL
                        WEBHOOK_URL = val or WEBHOOK_URL
                    elif key == 'EMITTER_HTTP_PORT':
                        global HTTP_PORT
                        try:
                            HTTP_PORT = int(val)
                        except Exception:
                            pass
                    elif key == 'EMITTER_BIND_HOST':
                        global BIND_HOST
                        BIND_HOST = val or BIND_HOST
                    elif key == 'EMITTER_POLL_INTERVAL':
                        global POLL_INTERVAL
                        try:
                            POLL_INTERVAL = int(val)
                        except Exception:
                            pass
                    elif key == 'EMITTER_LOOKBACK_SECONDS':
                        global LOOKBACK_SECONDS
                        try:
                            LOOKBACK_SECONDS = int(val)
                        except Exception:
                            pass
                    elif key == 'APNS_AUTH_KEY_PATH':
                        global APNS_AUTH_KEY_PATH
                        APNS_AUTH_KEY_PATH = val or APNS_AUTH_KEY_PATH
                    elif key == 'APNS_KEY_ID':
                        global APNS_KEY_ID
                        APNS_KEY_ID = val or APNS_KEY_ID
                    elif key == 'APNS_TEAM_ID':
                        global APNS_TEAM_ID
                        APNS_TEAM_ID = val or APNS_TEAM_ID
                    elif key == 'APNS_TOPIC':
                        global APNS_TOPIC
                        APNS_TOPIC = val or APNS_TOPIC
                    elif key == 'APNS_ENV':
                        global APNS_USE_SANDBOX
                        APNS_USE_SANDBOX = (val or 'sandbox') == 'sandbox'
                    elif key == 'APNS_DEVICE_TOKENS':
                        global DEVICE_TOKENS
                        DEVICE_TOKENS = [t.strip() for t in (val or '').split(',') if t.strip()]
        except Exception:
            pass

def connect_db():
    if pymysql is None:
        raise RuntimeError('PyMySQL no instalado')
    return pymysql.connect(host=DB_HOST, user=DB_USER, password=DB_PASSWORD, database=DB_NAME, port=DB_PORT, autocommit=True, cursorclass=pymysql.cursors.DictCursor)

def fetch_messages_since(conn, since_dt):
    q = "SELECT id, channel_id, content, created_at, event_at FROM tify_messages WHERE created_at > %s ORDER BY created_at ASC"
    with conn.cursor() as cur:
        cur.execute(q, (since_dt,))
        return cur.fetchall()

def init_apns():
    if APNsClient is None or Payload is None or TokenCredentials is None:
        return None
    if not (APNS_AUTH_KEY_PATH and APNS_KEY_ID and APNS_TEAM_ID):
        return None
    creds = TokenCredentials(auth_key_path=APNS_AUTH_KEY_PATH, key_id=APNS_KEY_ID, team_id=APNS_TEAM_ID)
    return APNsClient(credentials=creds, use_sandbox=APNS_USE_SANDBOX)

def notify_webhook(message):
    if requests is None or not WEBHOOK_URL:
        return False
    try:
        payload = {
            'type': 'emergency',
            'id': message['id'],
            'channelId': message['channel_id'],
            'content': message['content'],
            'createdAt': message['created_at'].isoformat() if hasattr(message['created_at'], 'isoformat') else str(message['created_at'])
        }
        r = requests.post(WEBHOOK_URL, json=payload, timeout=5)
        return r.status_code >= 200 and r.status_code < 300
    except Exception:
        return False

def notify_apns(client, content, tokens):
    if client is None or not APNS_TOPIC:
        return False
    tokens = [t for t in (tokens or []) if t]
    if not tokens:
        return False
    try:
        alert = {'title': 'Emergencia', 'body': content}
        payload = Payload(alert=alert, sound='default', badge=1)
        ok = True
        for token in tokens:
            try:
                client.send_notification(token, payload, APNS_TOPIC)
            except Exception:
                ok = False
        return ok
    except Exception:
        return False

def load_device_tokens(conn):
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT handle FROM tify_user_messaging_settings WHERE platform='PUSH' AND handle IS NOT NULL")
            rows = cur.fetchall()
            return [r['handle'] for r in rows]
    except Exception:
        return []

def get_recipient_tokens(conn, channel_id, created_at_iso):
    try:
        created_dt = datetime.fromisoformat(created_at_iso.replace('Z', '+00:00')) if isinstance(created_at_iso, str) else created_at_iso
    except Exception:
        created_dt = None
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT ums.handle
                FROM tify_channel_subscriptions cs
                JOIN tify_user_messaging_settings ums ON ums.user_id = cs.user_id
                WHERE cs.channel_id = %s
                  AND cs.is_active = 1
                  AND cs.receive_messages = 1
                  AND ums.platform = 'PUSH'
                  AND ums.is_enabled = 1
                  AND ums.handle IS NOT NULL
                  AND (%s IS NULL OR cs.subscribed_at <= %s)
                """,
                (channel_id, created_dt, created_dt)
            )
            rows = cur.fetchall()
            return [r['handle'] for r in rows]
    except Exception:
        return []

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
            return
        if self.path == '/events':
            try:
                body = json.dumps(RECENT_EVENTS).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                self.wfile.write(body)
            except Exception:
                self.send_response(500)
                self.end_headers()
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except Exception:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b'{}'
        try:
            data = json.loads(raw.decode('utf-8'))
        except Exception:
            data = {}

        if self.path == '/send':
            content = '👋 ' + (data.get('content') or 'Prueba de emergencia')
            ok = False
            try:
                ok = notify_apns(GLOBAL_APNS_CLIENT, content, DEVICE_TOKENS)
            except Exception:
                ok = False
            self.send_response(200 if ok else 500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            resp = {'sent': bool(ok), 'tokens': len(DEVICE_TOKENS)}
            self.wfile.write(json.dumps(resp).encode('utf-8'))
            return

        if self.path == '/event':
            try:
                base = data.get('content') or ''
                ev = data.get('eventAt')
                date_str = _format_event_date(ev) if ev else None
                content = "👋 " + (base if not date_str else f"{base} · {date_str}")
                created_iso = data.get('createdAt') or datetime.now(timezone.utc).isoformat()
                channel_id = data.get('channelId') or 'unknown'
                evt = {
                    'id': data.get('id') or f"local_{int(time.time()*1000)}",
                    'channelId': channel_id,
                    'content': content,
                    'createdAt': created_iso,
                    'eventAt': ev
                }
                _upsert_event(evt)
                try:
                    tokens = get_recipient_tokens(GLOBAL_DB_CONN, channel_id, created_iso)
                    if tokens:
                        notify_apns(GLOBAL_APNS_CLIENT, content, tokens)
                except Exception:
                    pass
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'ok': True}).encode('utf-8'))
                return
            except Exception:
                self.send_response(500)
                self.end_headers()
                return

        self.send_response(404)
        self.end_headers()

def start_http_server():
    print(f"Initializing HTTP server")
    try:
        srv = ThreadingHTTPServer((BIND_HOST, HTTP_PORT), Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        print(f"Emitter HTTP listening {BIND_HOST}:{HTTP_PORT}")
        base_local = f"http://localhost:{HTTP_PORT}"
        base_ip = (f"http://{BIND_HOST}:{HTTP_PORT}" if BIND_HOST and BIND_HOST != '0.0.0.0' else None)
        print("Available endpoints:")
        print(f"  GET  {base_local}/health" + (f"    |    {base_ip}/health" if base_ip else ""))
        print(f"  GET  {base_local}/events" + (f"    |    {base_ip}/events" if base_ip else ""))
        print(f"  POST {base_local}/event" + (f"    |    {base_ip}/event" if base_ip else ""))
        print(f"  POST {base_local}/send" + (f"    |    {base_ip}/send" if base_ip else ""))
    except Exception as e:
        print(f"Failed initializing HTTP server: {e}")
        try:
            fallback = '0.0.0.0'
            srv = ThreadingHTTPServer((fallback, HTTP_PORT), Handler)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            print(f"Emitter HTTP listening {fallback}:{HTTP_PORT}")
            base_local = f"http://localhost:{HTTP_PORT}"
            print("Available endpoints:")
            print(f"  GET  {base_local}/health")
            print(f"  GET  {base_local}/events")
            print(f"  POST {base_local}/event")
            print(f"  POST {base_local}/send")
        except Exception as e2:
            print(f"Fallback failed: {e2}")
            pass

def main():
    try:
        print(f"Emitter running host={socket.gethostname()} cwd={os.getcwd()} pid={os.getpid()}")
        print(f"DB target host={DB_HOST} db={DB_NAME} port={DB_PORT} interval={POLL_INTERVAL}s lookback={LOOKBACK_SECONDS}s")
    except Exception:
        pass
    _load_backend_env()
    start_http_server()
    conn = connect_db()
    apns_client = init_apns()
    global GLOBAL_APNS_CLIENT, GLOBAL_DB_CONN
    GLOBAL_APNS_CLIENT = apns_client
    GLOBAL_DB_CONN = conn
    try:
        tokens = load_device_tokens(conn)
        if tokens:
            global DEVICE_TOKENS
            DEVICE_TOKENS = tokens
    except Exception:
        pass
    last_checked = datetime.now(timezone.utc) - timedelta(seconds=LOOKBACK_SECONDS)
    while True:
        try:
            rows = fetch_messages_since(conn, last_checked)
            if rows:
                latest = last_checked
                for row in rows:
                    try:
                        base = row.get('content') or ''
                        evdt = row.get('event_at')
                        ev_iso = (evdt.isoformat() if evdt and hasattr(evdt, 'isoformat') else (str(evdt) if evdt else None))
                        date_str = _format_event_date(ev_iso) if ev_iso else None
                        content = "👋 " + (base if not date_str else f"{base} · {date_str}")
                        evt = {
                            'id': row['id'],
                            'channelId': row['channel_id'],
                            'content': content,
                            'createdAt': row['created_at'].isoformat() if hasattr(row['created_at'], 'isoformat') else str(row['created_at']),
                            'eventAt': ev_iso
                        }
                        _upsert_event(evt)
                    except Exception:
                        pass
                    sent = False
                    if WEBHOOK_URL:
                        sent = notify_webhook(row)
                    try:
                        tokens = get_recipient_tokens(conn, row['channel_id'], row['created_at'].isoformat() if hasattr(row['created_at'], 'isoformat') else str(row['created_at']))
                        if tokens:
                            notify_apns(apns_client, content, tokens)
                            sent = True
                    except Exception:
                        pass
                    cdt = row['created_at']
                    if isinstance(cdt, datetime) and cdt.tzinfo is None:
                        cdt = cdt.replace(tzinfo=timezone.utc)
                    if isinstance(cdt, datetime) and cdt > latest:
                        latest = cdt
                last_checked = latest
            time.sleep(POLL_INTERVAL)
        except KeyboardInterrupt:
            break
        except Exception:
            time.sleep(POLL_INTERVAL)
    try:
        conn.close()
    except Exception:
        pass

if __name__ == '__main__':
    main()