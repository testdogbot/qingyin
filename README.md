# 清音 Qingyin

一个轻量的自建音乐网站，自己听用。只接入**正版免费**曲库和**你自己的文件**：

| 来源 | 内容 | 音质 | 下载 |
|---|---|---|---|
| [Jamendo](https://www.jamendo.com) | 数十万首独立音乐（CC 授权） | FLAC / MP3 | 作者允许的曲目可下载 |
| [Internet Archive](https://archive.org) | 海量现场录音、网络厂牌专辑 | 大量 FLAC | 可下载 |
| 我的曲库 | 你上传的 FLAC / MP3 / M4A / OGG / OPUS / WAV | 原样 | 可下载 |

## 功能

- 发现页：Jamendo 编辑精选 + 风格分类，Archive 无损热门专辑
- 搜索：Jamendo 单曲 / Archive 专辑 / 本地曲库
- 播放器：FLAC 优先（失败自动降到 MP3）、一键切音质、队列、随机/单曲/列表循环、拖动进度、音量记忆、键盘快捷键、系统媒体控制（锁屏/耳机按键）
- 下载：在线曲目经服务器转发，自动命名为「歌手 - 标题.flac」
- 存进曲库：把在线曲目下载到服务器，永久离线可用
- 上传：拖拽多文件，自动读取 FLAC / ID3 标签、采样率、位深
- 歌单：「我喜欢」+ 自建歌单
- 单用户密码登录，适配手机，可装成 PWA

## 技术

- Node.js ≥ 22.13，唯一依赖 `express`；数据库用内置 `node:sqlite`
- 前端原生 JS，无构建步骤
- 数据全部在 `DATA_DIR`（`qingyin.db` + `music/`）

## 本地运行

```bash
npm install
npm start            # http://127.0.0.1:8791
npm test
```

首次打开设置访问密码。Jamendo 需要免费 Client ID：到 <https://devportal.jamendo.com> 注册并创建应用，在网页「设置」里填写，或设环境变量 `JAMENDO_CLIENT_ID`。不填也能用 Archive 和本地曲库。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8791 | 端口 |
| `HOST` | 127.0.0.1 | 监听地址 |
| `DATA_DIR` | ./data | 数据目录 |
| `JAMENDO_CLIENT_ID` | 空 | 也可在网页设置 |
| `MAX_UPLOAD_MB` | 800 | 单文件上传上限 |

## 部署（参考）

`deploy/qingyin.service`（systemd）和 `deploy/nginx.conf`（反向代理，含大文件上传设置）。

```bash
git clone <repo> /opt/qingyin && cd /opt/qingyin && npm ci --omit=dev
mkdir -p /var/lib/qingyin
cp deploy/qingyin.service /etc/systemd/system/ && systemctl enable --now qingyin
```

## 说明

- 下载代理只允许 `archive.org`、`jamendo.com` 的 HTTPS 地址。
- Jamendo 内容多为 CC BY-NC 等授权，仅限个人非商业使用；Archive 条目的授权见各自页面。
- 不接入任何破解/非官方的商业平台接口。
