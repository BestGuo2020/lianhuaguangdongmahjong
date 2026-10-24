"""Local-only WS acceptance server; never opens the developer's real database."""
from pathlib import Path
import os
import sys
import uuid

root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(root / 'backend'))
os.environ['PG_PASSWORD'] = ''
os.environ['WAKUDEMO_LOGIN_BYPASS'] = 'false'
os.environ['WAKUDEMO_COOKIE_SECURE'] = 'false'
os.environ['WAKUDEMO_COOKIE_SAMESITE'] = 'lax'
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

from app.storage import db

evidence = root / 'tmp' / 'ws-e2e'
evidence.mkdir(parents=True, exist_ok=True)
db.storage = db.Storage(str(evidence / f'{uuid.uuid4().hex}.sqlite'))

from fastapi import Request
from fastapi.responses import JSONResponse
from app.main import app
from app.auth.wakudemo import get_wakudemo_oauth_service


@app.post('/api/__e2e__/login')
async def test_login(request: Request):
    """仅此本机夹具提供：创建真实 Cookie 会话，后续房间请求走正常身份鉴权。"""
    payload = await request.json()
    account = {'id': uuid.uuid4().hex, 'displayName': payload['nickname'], 'avatarUrl': None}
    service = get_wakudemo_oauth_service()
    session = service.create_session('local-e2e-token', 3600, account)
    response = JSONResponse({'authenticated': True})
    response.set_cookie(service.config.cookie_name, session, httponly=True, samesite='lax')
    return response

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=int(sys.argv[1]), log_level='warning')
