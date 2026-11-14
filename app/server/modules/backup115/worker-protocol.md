# 115 Python worker 协议

## 范围与运行环境

worker 只实现 115 SDK 适配，不提供 HTTP API、Node 调用端、前端或 Docker 配置。每个命令启动一个独立 Python 进程，Python 必须 >=3.12，发行依赖精确固定为 `p115client==0.0.9.6.5.1`（仓库根 `requirements.txt`）。不要依赖 SDK 模块的 `__version__`，其值不足以区分此发行版；worker 使用 distribution metadata 检查完整版本。

启动形式：`<独立环境Python> -B app/server/modules/backup115/worker.py`。调用端必须通过 stdin 传一行 UTF-8 JSON 并加换行，最大 65536 字节，随后关闭 stdin。无 CLI 参数、无 cookie 路径参数。命令参数采用白名单；多余字段会拒绝。仅处理第一行，处理后退出。

成功退出码为 0，失败为 1。stdout 只输出 NDJSON，每行一个对象；恰好一个终结事件，终结事件前可以有 progress。调用端必须同时检查退出码、终结事件和进程超时，不能把退出或最后一个 progress 当成成功。调用端负责合理的长上传超时、取消、重试退避、并发限制与任务持久化；建议同一账号上传串行、授权/注销与上传互斥。

## 环境与状态边界

- `BACKUP115_DIR`：可信服务端配置的固定私密状态目录，缺省为 `DATA_DIR/backup115`；`DATA_DIR` 缺省 `data`。生产应显式传绝对目录。禁止从浏览器请求复制环境变量。
- `RECORDINGS_DIR`：允许上传的录像根目录，应显式配置绝对路径。不设置时不允许普通录像路径。
- `BACKUP115_REMOTE_ROOT`：允许的绝对远端根目录，缺省 `/48tools`。`upload.remoteDir` 必须等于该根或位于其真正的子目录，而不是字符串同前缀。服务端若允许配置其他绝对根，必须明确将此配置传给 worker，不能把单次上传请求当作根配置。
- 本地附件额外允许固定 `BACKUP115_DIR/files` 子树；此目录绝不能由调用请求指定或替换。
- Cookie 只在固定 `BACKUP115_DIR/cookies.json` 管理，内部 JSON 格式不是公开协议。签入成功且真实账号检查通过后才原子写入，目录 0700、文件 0600，同目录临时文件、fsync、replace，Linux 再 fsync 目录。Windows `chmod` 不等价于 POSIX ACL，部署方仍需私密服务账号目录 ACL；生产目标为 Linux。
- SDK 的 `const.py` 在导入时创建 `~/.p115client.cache.d`，`util.py` 在导入时读取缓存。worker 在导入 SDK 前强制将进程 HOME/USERPROFILE 指向 BACKUP115_DIR，并设置 umask 077；因此 SDK 用户键缓存不会读取主机既有 home。目录、已知缓存及 lock 文件不得为符号链接。不要在此独立进程启动前预加载 SDK。
- 状态目录不能由不可信用户写入；录像根也必须由服务控制，不得允许不可信进程替换目录、植入硬链接或修改正在上传的文件。worker 拒绝路径任一组成部分的符号链接/Windows junction，Linux 使用逐段 `O_NOFOLLOW + dir_fd` 打开源文件。已打开句柄被保留到核验结束，上传前后比较 inode、size、时间及实际 SHA1；不删除任何本地录像或附件。
- 即使 RECORDINGS_DIR 配得过宽，状态目录也不能作为上传来源，唯一例外是其固定 files 子目录。不要把凭证或 `.env` 放在 files 或录像目录。

## 输出事件

阶段事件示例：`{"type":"progress","phase":"uploading"}`。此 SDK 接口没有接入可靠的逐字节回调，所以 worker **不输出 bytes/total、百分比或伪造计数**。未来只有真实传输计数可用时才可增加 `bytes`、`total`。目前阶段名为 validating_source、checking_account、ensuring_directory、checking_existing、uploading、verifying；命中已有远端文件不会出现 uploading。

成功：`{"type":"result","data":{...}}`。

失败：`{"type":"error","code":"unauthorized","message":"Authorization required; waiting for explicit QR login."}`。

SDK stdout/stderr（含 native fd 1/2）、logging 和 warnings 均静默，专用复制出的 stdout 句柄仅写协议事件。不得转发 SDK 响应、异常文本、Cookie、签名 URL 或用户昵称。QR URL 仅在 qr_start 的指定字段中返回，不能进入日志；QR token 也不能进入日志或公开状态 API。

## 命令

### status

输入：`{"command":"status"}`。

输出 data：`{runtimeAvailable:boolean,cookiePresent:boolean,authorized:false,message:string}`。只探测 Python、完整发行版本/模块存在以及固定 cookie 文件存在且非空。**不导入 SDK、不读取 cookie 内容、不创建状态目录、不进行网络请求**。authorized 恒为 false 表示未做实网验证，不能据此覆盖最近一次 check 的账号；cookiePresent 不证明授权有效。

### check

输入：`{"command":"check"}`。

成功 data：`{runtimeAvailable:true,authorized:true,accountId:string,accountLabel:string,message:string}`。依次调用 `client.login_status()`、`check_response(client.user_info())`；响应账号 ID 必须与 client.user_id 一致。accountLabel 为掩码账号尾号而非上游昵称。

库不可用时返回 runtimeAvailable:false、authorized:false、accountId:null、accountLabel:null 及固定提示；无 Cookie 或 Cookie 已失效时返回 runtimeAvailable:true、authorized:false 和同样空账号字段，明确等待用户发起扫码。网络或不可识别响应失败返回 error，不伪装为“未登录”。

### qr_start

输入：`{"command":"qr_start"}`。

调用静态 `P115Client.login_qrcode_token()`，输出 data：`{token:{uid:string,time:number,sign:string},qrUrl:string,expiresIn:120}`。qrUrl 由固定的 `https://115.com/scan/dg-` 与 uid 构建，不转发任意 SDK URL。token 仅供父 Node 内部暂存，API 应给浏览器不透明会话 ID 而非直接暴露 token。worker 不自行展示终端二维码。

### qr_poll

输入：`{"command":"qr_poll","token":{"uid":"...","time":0,"sign":"..."},"app":"alipaymini"}`。app 可省略，白名单为 alipaymini、web、android、ios、qandroid、ipad、tv。父调用端须在同一会话保持 app 一致，限制轮询频率并拒绝已取消/超时会话重放。

token 时间超过 120 秒（或未来超过 30 秒）直接返回 expired，不发网。有效时调用静态 `login_qrcode_scan_status(token)`。data 为 `{status,connection}`，status 是 waiting、scanned、signed_in、expired、canceled，connection 平时为 null。SDK 未知状态会失败，不推测成功。

signed_in 时调用静态 `login_qrcode_scan_result(uid,app=...)`，用其中 Cookie 构造 P115Client，真实检查账号，原子保存固定 Cookie；connection 为 check 的已授权对象。**永不返回 Cookie，也不返回 SDK 原始响应。**

### logout

输入：`{"command":"logout"}`。无网络、无需 SDK。幂等移除固定 Cookie，返回 `{"authorized":false}`。不调用远端注销 API、不删除文件或备份。父 Node 必须先阻止并行登录/上传并取消现有扫码会话，避免运行中的另一个进程再次保存 Cookie。SDK 缓存位于私密目录内，不作为之后的授权来源；没有 Cookie 不构造客户端。

### upload

输入字段：command、localPath（本机绝对路径）、remoteDir（绝对远端目录）、filename（单一合法段）、size（非负整数）、sha1（40 位十六进制）、expectedAccountId（正整数十进制字符串）、可选 remoteFileId（同样 ID 格式）。调用端不得传 cookie、cookiePath、root、URL、任意 SDK 参数或分片大小。

处理顺序：

1. 校验远端目录、允许根/文件名和 expectedAccountId；路径拒绝空段、`.`、`..`、反斜杠、控制字符、首尾空白、无效字符和超长段，目录最多 25 层。
2. realpath 及无符号链接安全校验；源必须为允许根下普通文件，打开后比对 inode，实际 size 和 SHA1 必须与声明一致。
3. 固定 Cookie 构造客户端并真实检查账号，账号与 expectedAccountId 不一致立即 mismatch，不创建目录或上传。绝不使用 `P115Client(cookies=None)`，因为这会触发自动扫码。
4. 逐段以 `fs.iterdir(parentId)` 查找目录，不存在时调用实际存在的 `client.fs_mkdir(name,pid=parentId)` 并重新查找。此发行版全包没有 fs.makedirs，不使用猜测 API。发现同名非目录/多个目录即失败，不写错误目标。
5. 若传 remoteFileId，直接 fresh 按 ID 核验它，不能据此跳过校验，也不盲目再次上传。否则 fresh 列举目标目录，先找同名 SHA1/size 一致的文件，复用后仍必须 fresh 按 ID 核验。
6. 未命中才调用 `client.upload_file(已打开句柄,pid=...,filename=...,filesha1=...,filesize=...,partsize=16777216)`。固定 16 MiB 分片（>=10 MiB），支持 SDK 秒传；不依赖 SDK upload 回调的缓存 metadata。
7. 上传后 fresh 列表解析匹配文件 ID；若无法唯一识别则失败，绝不返回“已验证”。随后强制 `fs.get_attr(int(fileId),refresh=True)`，核验 id、parent_id、name、size、sha1、is_dir，缺字段、类型错或值不符全部失败。此 SDK 默认 get_attr 走 client.fs_file 并归一化 parent_id，未使用 skim 简略元数据。
8. 源句柄再次核验实际 SHA1/size/修改时间，成功才返回终结 result。远端失败或源变化时保留本地文件；不会自动删除可能已写入的远端对象，父任务应等待重试/人工处理。

成功 data：`{remote:{fileId:string,parentId:string,name:string,size:number,sha1:string,path:string},verified:true,accountId:string}`。SHA1 统一大写，path 是经验证的请求远端目录及 filename。ID 使用字符串避免 Node 数值精度损失。

## 错误与调用方责任

错误码：unauthorized、quota、network、mismatch、source_changed、provider_error、invalid_request、invalid_path、runtime_unavailable、state_error。message 全部为内部固定文本，不包含 SDK 任意异常内容。quota/auth/network 优先按异常类型及继承链映射，未知错误保守归为 provider_error；不进行未经验证的账号重登录、上传重试或数据删除。

Node 负责鉴权、CSRF、扫码会话及 token 私密存储、API 脱敏、任务锁/取消、容量策略、审计与超时。禁止直接把浏览器参数整体转发给 worker；不得记录 stdin、QR token、QR URL、cookie 文件内容及 SDK 响应。不能将 worker 未验证成功的对象标记为备份完成或据此删本地录像。

## 离线测试与当前验证边界

测试命令：`<Python3.12> -B app/server/test/backup115-worker.test.py`。测试使用临时目录、人工假 Cookie 和 fake provider，只测试协议/路径/账号/上传核验/状态，不访问任何主机已有 Cookie、`.env` 或凭证，不进行实际登录、网络或上传。实网端到端行为须在用户之后明确授权的受控环境验证，不能将 mock 测试表述成账号检查或上传已实测。

## 许可证与发布门禁

worker 为新适配代码，没有复制 SDK 源码；`p115client` 及其传递依赖的版权和许可证独立于本仓库，安装、分发或打包不能视为自动重新许可。父代理已只读核实本机已安装发行包 `p115client==0.0.9.6.5.1` 的 METADATA（License: MIT，Classifier: MIT License）及 dist-info/licenses/LICENSE 原文，已随本模块保留为 PROVIDER-LICENSE.txt。运行环境保留各依赖的 dist-info 许可证；发布记录保存实际依赖版本。此结论针对该精确发行版，并不声称官网最新版本已核实；不涉及读取业务凭证。
