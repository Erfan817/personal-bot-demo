#!/usr/bin/env python3
"""B站扫码登录（直连官方接口版）—— 不经过 bilibili-api 的登录封装。
流程 = bilibili-API-collect 文档的标准三步：
  1. GET generate → 拿 qrcode_key + 登录 url
  2. 用 url 画二维码 PNG（和 key 绝对同源）
  3. 轮询 poll：86101 未扫 / 86090 已扫待确认 / 86038 失效 / 0 成功（带 cookie）
"""
import json
import time
from pathlib import Path

import httpx
import qrcode

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Referer": "https://www.bilibili.com/",
}
GEN = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
POLL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"

HERE = Path(__file__).parent
CRED_FILE = HERE / "bili_credential.json"
PNG_FILE = HERE / "bili_qr.png"


def main():
    for attempt in range(1, 6):
        gen = httpx.get(GEN, headers=HEADERS, timeout=10).json()["data"]
        url, key = gen["url"], gen["qrcode_key"]
        qrcode.make(url).save(PNG_FILE)
        print(f"QR_READY attempt={attempt}", flush=True)

        for _ in range(90):  # 180s
            resp = httpx.get(POLL, params={"qrcode_key": key}, headers=HEADERS, timeout=10)
            d = resp.json()["data"]
            code = d.get("code")
            if code == 0:
                # B站 新版返回：cookie 在 Set-Cookie 响应头里（url 里已经没有了）
                cookies = {}
                for sc in resp.headers.get_list("set-cookie"):
                    pair = sc.split(";", 1)[0]
                    if "=" in pair:
                        k, v = pair.split("=", 1)
                        cookies[k.strip()] = v.strip()
                print("[poll] set-cookie 字段:", sorted(cookies.keys()), flush=True)
                # 兜底：老格式把 cookie 放在返回 url 的查询参数里
                for kv in (d.get("url") or "").split("?", 1)[-1].split("&"):
                    if "=" in kv:
                        k, v = kv.split("=", 1)
                        cookies.setdefault(k, v)
                cred = {
                    "sessdata": cookies.get("SESSDATA", ""),
                    "bili_jct": cookies.get("bili_jct", ""),
                    "buvid3": cookies.get("buvid3", ""),
                    "dedeuserid": cookies.get("DedeUserID", ""),
                }
                if not cred["sessdata"]:
                    print("[poll] code=0 但没有 SESSDATA", flush=True)
                    break
                with open(CRED_FILE, "w") as f:
                    json.dump(cred, f)
                Path(CRED_FILE).chmod(0o600)
                print("LOGIN_OK", flush=True)
                return
            if code == 86038:
                print("[poll] 86038 二维码已失效", flush=True)
                break
            if code == 86090:
                print("[poll] 86090 已扫码，等手机确认", flush=True)
            time.sleep(2)
        print(f"QR_TIMEOUT_RETRY（第 {attempt} 轮）", flush=True)


main()
