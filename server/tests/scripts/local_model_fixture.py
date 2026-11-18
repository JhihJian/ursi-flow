"""Single-purpose loopback SSE fixture for the real Runtime ACP acceptance test."""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # Do not log request headers or message bodies.

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if not (self.path == '/v1/chat/completions' and data.get('stream') is True
                and data.get('model') == 'fixed' and data.get('messages')):
            self.send_error(400)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for delta, reason in [({'role': 'assistant', 'content': 'ACP-OK'}, None), ({}, 'stop')]:
            event = {'id': 'local', 'object': 'chat.completion.chunk', 'created': 1,
                     'model': 'fixed', 'choices': [{'index': 0, 'delta': delta,
                                                    'finish_reason': reason}]}
            self.wfile.write(b'data: ' + json.dumps(event).encode() + b'\n\n')
        self.wfile.write(b'data: [DONE]\n\n')
        print('served fixed completion', flush=True)


if __name__ == '__main__':
    HTTPServer(('127.0.0.1', 18080), Model).serve_forever()
