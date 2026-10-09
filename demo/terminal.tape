# 终端录屏：用 VHS 跑（brew install vhs），在仓库根目录执行 npm run record:terminal
# 数据在临时目录里，只有示例项目“记账小程序”，不读你本机的对话。
Output docs/media/terminal.gif
Output docs/media/terminal.mp4

Set Shell bash
Set FontSize 19
Set Width 1320
Set Height 800
Set Padding 28
Set TypingSpeed 70ms
# 帧率别设高：VHS 逐帧截图，截不过来时成片会被压快
Set Framerate 12
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful

Hide
Type 'export CORPUS_HOME="$(mktemp -d)" PATH="$PWD/bin:$PATH" PS1="$ " && crew demo > /dev/null && clear'
Enter
Sleep 2s
Show

Type@20ms "# 所有项目，一行一个"
Enter
Type "crew"
Sleep 300ms
Enter
# voice-hold：讲解视频会把下面这行换成“念完稍停”（demo/explainer.ts）
Sleep 6s

Type@5ms "clear"
Enter
Type@20ms "# 一个项目的现场：规划、任务、下一步"
Enter
Type "crew show"
Sleep 300ms
Enter
# voice-hold
Sleep 12s

Type@5ms "clear"
Enter
Type@20ms "# 换个工具接着做：取“月度导出”的续接上下文"
Enter
Type "crew context --task T04"
Sleep 300ms
Enter
# voice-hold
Sleep 12s
