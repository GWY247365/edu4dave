# 数学小练习 (Math Quiz)

为小朋友在 iPad 上做的互动数学练习单页应用。

## 题目设置

- 共 10 题：6 道乘法（最大到 12×12）、2 道三位数加法、2 道三位数减法
- 限时 10 分钟，超时弹窗提醒并继续正向计时（+mm:ss）
- "New quiz" 重新出题；"Check answers" 批改并对错题给出 **错因诊断 + 正确解法**
- 自适应出题：错过的乘法事实会按权重在下次 quiz 中加倍出现（间隔重复）；加减法按"进位/借位"难度分桶并按弱点偏向出题
- 每日连胜（🔥 streak）：连续天数完成 quiz 会显示火苗图标；中断超过 1 天自动归零
- 📊 Progress 面板：累计 quiz 数、平均分、乘法事实掌握进度、加减法各难度桶准确率、最近 10 次 quiz 柱状图

## PWA：当作 App 用

- iPad Safari 打开网址 → 分享 → "添加到主屏幕"
- 之后从主屏图标启动是全屏无浏览器栏，**离线可用**（service worker 缓存了所有静态资源）
- 所有数据都存在 iPad 本地（localStorage），不上传任何服务器

## 错因诊断举例

- 乘法：相邻乘法表混淆（7×7 vs 7×8）、加减法当成乘法、漏加一项、数字反写等；并给出乘法策略（如 `×9 = ×10 − 自身`）
- 加法：忘记进位、多/少进位、做成减法
- 减法：没借位（取绝对值）、被减数减数颠倒、做成加法、多/少借位
- 每道错题都附上完整 **竖式计算步骤** 教正确解法

## 本地预览

直接在浏览器打开 `index.html` 即可，没有任何依赖。

或起一个本地服务器：

```bash
python3 -m http.server 8080
# 然后在 iPad/电脑浏览器打开 http://<电脑IP>:8080
```

## 部署到 Vercel（免费）

### 方法 A：用 GitHub 一键部署（推荐，最省事）

1. 把这个仓库 push 到 GitHub（已经在 `claude/math-quiz-app-7CzcR` 分支）
2. 打开 https://vercel.com/new
3. 用 GitHub 登录，选择这个仓库 → Import
4. Framework Preset 选 **Other**（纯静态），其他全部默认，点 **Deploy**
5. 30 秒后会拿到一个 `https://xxx.vercel.app` 链接，把链接加到 iPad 主屏幕（Safari → 分享 → 添加到主屏幕）就能像 App 一样用

### 方法 B：用 Vercel CLI

```bash
npm i -g vercel
vercel            # 第一次会让你登录、确认项目
vercel --prod     # 部署到正式环境
```

### 其他免费选项

- **Cloudflare Pages**：https://pages.cloudflare.com/ 同样把仓库连上即可
- **GitHub Pages**：在仓库 Settings → Pages 选 `main` 分支即可（但需要先合并到 main）
- **Netlify Drop**：https://app.netlify.com/drop 把整个文件夹拖进去就部署
