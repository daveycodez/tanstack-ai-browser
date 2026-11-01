import http.server, sys, time
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get('content-length',0)); b=self.rfile.read(n).decode('utf-8','replace')
        print(time.strftime('%H:%M:%S'), b[:2000], flush=True)
        self.send_response(204); self.send_header('Access-Control-Allow-Origin','*'); self.end_headers()
    def do_OPTIONS(self):
        self.send_response(204); self.send_header('Access-Control-Allow-Origin','*'); self.send_header('Access-Control-Allow-Headers','*'); self.end_headers()
    def log_message(self,*a): pass
http.server.ThreadingHTTPServer(('127.0.0.1',3999),H).serve_forever()
