"""Two-response OpenAI SSE fixture: read one real Pi input, then finish."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from threading import Thread

API_KEY = 'local-acceptance-key'
MODEL = 'acceptance-model'
INPUT_PATH = 'material.txt'
ANSWER = '# Pi acceptance complete'


class OpenAIStub(HTTPServer):
    def __init__(self):
        super().__init__(('0.0.0.0', 0), Handler)
        self.requests = []
        self.thread = Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    @property
    def provider(self):
        return {'api': 'openai-completions', 'model': MODEL, 'apiKey': API_KEY,
                'baseUrl': f'http://127.0.0.1:{self.server_port}/v1'}

    def close(self):
        self.shutdown()
        self.server_close()
        self.thread.join()


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def log_message(self, *args):
        pass

    def do_POST(self):
        if self.client_address[0] != '127.0.0.1':
            self.send_error(403)
            return
        length = int(self.headers.get('Content-Length', 0))
        if not 0 < length <= 1024 * 1024:
            self.send_error(400)
            return
        body = json.loads(self.rfile.read(length))
        auth = self.headers.get('Authorization')
        self.server.requests.append((self.path, auth, body))
        if self.path != '/v1/chat/completions' or auth != f'Bearer {API_KEY}':
            self.send_error(400)
            return
        number = len(self.server.requests)
        if number == 1:
            delta = {'tool_calls': [{'index': 0, 'id': 'acceptance-provider-tool-call', 'type': 'function',
                                     'function': {'name': 'read_input',
                                                  'arguments': json.dumps({'path': INPUT_PATH})}}]}
            finish = 'tool_calls'
        elif number == 2:
            delta = {'content': ANSWER}
            finish = 'stop'
        else:
            self.send_error(400)
            return

        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for chunk, reason in [({'role': 'assistant', **delta}, None), ({}, finish)]:
            data = {'id': f'acceptance-stream-{number}', 'model': MODEL, 'object': 'chat.completion.chunk',
                    'choices': [{'index': 0, 'delta': chunk, 'finish_reason': reason}]}
            self.wfile.write(b'data: ' + json.dumps(data).encode() + b'\n\n')
        self.wfile.write(b'data: [DONE]\n\n')
