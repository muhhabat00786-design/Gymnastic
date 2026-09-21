import asyncio
import json
import logging
import sys
import threading
import uuid
import weakref
import websockets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional, List, Dict, Any
from concurrent.futures import Future

# Configure logging to strictly use STDERR
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)

# Try to import FastMCP, mock if missing to prevent complete crash
# but warn about missing dependency. We'll use fastmcp package
try:
    from fastmcp import FastMCP
except ImportError:
    logger.error("fastmcp package not installed. Run 'pip install fastmcp websockets'. Exiting.")
    sys.exit(1)

# Global State
class ConnectionManager:
    def __init__(self):
        self.connected_clients = set()
        self.pending_requests: Dict[str, Future] = {}

    def add_client(self, websocket):
        self.connected_clients.add(websocket)
        logger.info("Chrome Extension connected")

    def remove_client(self, websocket):
        self.connected_clients.discard(websocket)
        logger.info("Chrome Extension disconnected")

    def has_connection(self) -> bool:
        return len(self.connected_clients) > 0

    async def send_command(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        if not self.has_connection():
            raise Exception("Chrome Extension is not connected")

        # Get an active connection (just pick the first one, usually there's only 1)
        ws = next(iter(self.connected_clients))

        req_id = str(uuid.uuid4())
        payload = {
            "id": req_id,
            "method": method,
            "params": params or {}
        }

        # Create a future to wait for the response
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self.pending_requests[req_id] = future

        await ws.send(json.dumps(payload))

        try:
            # Wait for response with timeout
            response = await asyncio.wait_for(future, timeout=30.0)
            if not response.get('success', False):
                error_msg = response.get('error', 'Unknown error')
                raise Exception(f"Browser error: {error_msg}")
            return response.get('result')
        finally:
            self.pending_requests.pop(req_id, None)

    def handle_response(self, response_data: dict):
        req_id = response_data.get('id')
        if req_id and req_id in self.pending_requests:
            future = self.pending_requests[req_id]
            if not future.done():
                future.set_result(response_data)


manager = ConnectionManager()
loop = asyncio.new_event_loop()
asyncio.set_event_loop(loop)

# -----------------------------------------------------------------------------
# WebSocket Server (Port 18822)
# -----------------------------------------------------------------------------
async def websocket_handler(websocket, path=None):
    manager.add_client(websocket)
    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                if data.get('type') == 'heartbeat':
                    continue
                manager.handle_response(data)
            except json.JSONDecodeError:
                logger.error("Invalid JSON received over WebSocket")
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        manager.remove_client(websocket)

async def start_websocket_server():
    try:
        # For websockets 10.x+, the signature is serve(handler, host, port)
        # Note: some newer websockets versions use process_request, but the basic form is the same.
        server = await websockets.serve(websocket_handler, "127.0.0.1", 18822)
        logger.info("WebSocket server started on ws://127.0.0.1:18822")
        await server.wait_closed()
    except Exception as e:
        logger.error(f"Failed to start WebSocket server: {e}")

def run_async_loop(loop):
    asyncio.set_event_loop(loop)
    loop.run_until_complete(start_websocket_server())

# -----------------------------------------------------------------------------
# HTTP REST Bridge (Port 18823)
# -----------------------------------------------------------------------------
class HTTPBridgeHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress default HTTP logging to stdout/stderr
        pass

    def _set_headers(self, status=200):
        self.send_response(status)
        self.send_header('Content-type', 'application/json')
        # Using a more secure CORS policy, only allowing local origin
        self.send_header('Access-Control-Allow-Origin', 'http://127.0.0.1:18823')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_OPTIONS(self):
        self._set_headers()

    def do_GET(self):
        if self.path == '/status':
            self._set_headers()
            response = {
                "server_running": True,
                "extension_connected": manager.has_connection()
            }
            self.wfile.write(json.dumps(response).encode())
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == '/api':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)

            try:
                req = json.loads(post_data.decode('utf-8'))
                method = req.get('method')
                params = req.get('params', {})

                if not method:
                    self._set_headers(400)
                    self.wfile.write(json.dumps({"error": "Missing method"}).encode())
                    return

                # Execute in the asyncio loop thread and wait for result
                future = asyncio.run_coroutine_threadsafe(
                    manager.send_command(method, params), loop
                )

                result = future.result(timeout=35.0)

                self._set_headers()
                self.wfile.write(json.dumps(result).encode())

            except Exception as e:
                self._set_headers(500)
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        else:
            self.send_error(404)

def start_http_server():
    try:
        server = ThreadingHTTPServer(('127.0.0.1', 18823), HTTPBridgeHandler)
        logger.info("HTTP Bridge started on http://127.0.0.1:18823")
        server.serve_forever()
    except Exception as e:
        logger.error(f"Failed to start HTTP server: {e}")

# -----------------------------------------------------------------------------
# MCP Server Setup
# -----------------------------------------------------------------------------
mcp = FastMCP("Chrome-Automation")

# Helper for executing async operations from sync MCP tools
def run_sync(coro):
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    try:
        return future.result(timeout=35.0)
    except Exception as e:
        raise RuntimeError(f"Command execution failed: {e}")

@mcp.tool()
def browser_status() -> str:
    """Returns connection state, active tab, and debugger status."""
    res = run_sync(manager.send_command('browser_status'))
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_navigate(url: str, new_tab: bool = False, wait_until: str = "dom") -> str:
    """Fast navigation. wait_until can be 'dom' or 'none'."""
    res = run_sync(manager.send_command('browser_navigate', {
        'url': url, 'new_tab': new_tab, 'wait_until': wait_until
    }))
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_trusted_click(selector: Optional[str] = None, x: Optional[int] = None, y: Optional[int] = None) -> str:
    """Hardware-level CDP click."""
    res = run_sync(manager.send_command('browser_trusted_click', {
        'selector': selector, 'x': x, 'y': y
    }))
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_trusted_type(text: str) -> str:
    """Hardware-level CDP typing."""
    res = run_sync(manager.send_command('browser_trusted_type', {'text': text}))
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_trusted_press_key(key: str) -> str:
    """Physical key dispatch. Supports keys like Enter, Escape, Tab, Backspace, ArrowUp, ArrowDown."""
    res = run_sync(manager.send_command('browser_trusted_press_key', {'key': key}))
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_wait_and_click(selector: str, timeout_seconds: int = 8) -> str:
    """Sub-25ms smart DOM click."""
    res = run_sync(manager.send_command('browser_wait_and_click', {
        'selector': selector, 'timeout_seconds': timeout_seconds
    }))
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_batch(steps: list) -> str:
    """Executes multi-step pipelines in browser memory with zero IPC delay."""
    res = run_sync(manager.send_command('browser_batch', {'steps': steps}))
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_upload_file(file_paths: List[str], selector: str = "input[type='file']") -> str:
    """Direct file upload."""
    res = run_sync(manager.send_command('browser_upload_file', {
        'file_paths': file_paths, 'selector': selector
    }))
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_screenshot(full_page: bool = False, output_path: str = "screenshot.png") -> str:
    """Saves screenshot to disk and returns local path."""
    res = run_sync(manager.send_command('browser_screenshot', {'full_page': full_page}))
    if res.get('status') == 'captured' and 'data' in res:
        import base64
        with open(output_path, "wb") as f:
            f.write(base64.b64decode(res['data']))
        return f"Screenshot saved to {output_path}"
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_annotate_elements() -> str:
    """Overlays Set-of-Marks tags ([1], [2]) on all interactive elements."""
    res = run_sync(manager.send_command('browser_annotate_elements'))
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_clear_annotations() -> str:
    """Wipes visual badges."""
    res = run_sync(manager.send_command('browser_clear_annotations'))
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_get_elements() -> str:
    """Extracts all interactive elements with bounding boxes and selectors."""
    res = run_sync(manager.send_command('browser_get_elements'))
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_get_text() -> str:
    """Extracts clean readable text and title."""
    res = run_sync(manager.send_command('browser_get_text'))
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_scroll(direction: str, amount: int) -> str:
    """Directional scrolling. direction: 'up' or 'down'"""
    res = run_sync(manager.send_command('browser_scroll', {
        'direction': direction, 'amount': amount
    }))
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_eval(script: str) -> str:
    """Evaluates JavaScript in page context."""
    res = run_sync(manager.send_command('browser_eval', {'script': script}))
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_cdp(method: str, params: dict) -> str:
    """Dispatches raw CDP commands."""
    res = run_sync(manager.send_command('browser_cdp', {
        'method': method, 'params': params
    }))
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_cookies(action: str, domain: str = "", name: str = "", value: str = "") -> str:
    """Cookie management. action: 'get_all' or 'set'"""
    res = run_sync(manager.send_command('browser_cookies', {
        'action': action, 'domain': domain, 'name': name, 'value': value
    }))
    return json.dumps(res, indent=2)

@mcp.tool()
def browser_tabs(action: str, tab_id: int = 0, url: str = "") -> str:
    """Tab orchestration. action: 'list', 'create', 'close', 'switch'"""
    res = run_sync(manager.send_command('browser_tabs', {
        'action': action, 'tab_id': tab_id, 'url': url
    }))
    return json.dumps(res, indent=2)


def main():
    # Start WebSocket server in a background thread
    ws_thread = threading.Thread(target=run_async_loop, args=(loop,), daemon=True)
    ws_thread.start()

    # Start HTTP Bridge server in a background thread
    http_thread = threading.Thread(target=start_http_server, daemon=True)
    http_thread.start()

    # Run the MCP server in the main thread (stdio)
    try:
        mcp.run(transport="stdio", show_banner=False)
    except KeyboardInterrupt:
        logger.info("Shutting down...")

if __name__ == "__main__":
    main()
