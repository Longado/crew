import AppKit
import WebKit
import CoreGraphics
import CoreText

func makeIcon(_ directory: String) {
    let sizes = [16,32,128,256,512]
    for size in sizes {
        for scale in [1,2] {
            let n = size * scale
            let color = CGColorSpaceCreateDeviceRGB()
            let ctx = CGContext(data:nil,width:n,height:n,bitsPerComponent:8,bytesPerRow:n*4,space:color,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
            ctx.scaleBy(x:CGFloat(n)/1024,y:CGFloat(n)/1024)
            ctx.setFillColor(CGColor(red:0.17,green:0.25,blue:0.21,alpha:1))
            ctx.addPath(CGPath(roundedRect:CGRect(x:50,y:50,width:924,height:924),cornerWidth:205,cornerHeight:205,transform:nil)); ctx.fillPath()
            let font=CTFontCreateWithName("Helvetica-Bold" as CFString,CGFloat(610),nil)
            let attrs: [NSAttributedString.Key:Any] = [.font:font,.foregroundColor:NSColor.white]
            let line=CTLineCreateWithAttributedString(NSAttributedString(string:"C",attributes:attrs))
            let width=CTLineGetTypographicBounds(line,nil,nil,nil)
            ctx.textPosition=CGPoint(x:(1024-width)/2,y:294); CTLineDraw(line,ctx)
            let bitmap=NSBitmapImageRep(cgImage:ctx.makeImage()!)
            let name="icon_\(size)x\(size)"+(scale==2 ? "@2x" : "")+".png"
            try! bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:directory).appendingPathComponent(name))
        }
    }
}
if CommandLine.arguments.count==3 && CommandLine.arguments[1]=="--make-icon" {
    makeIcon(CommandLine.arguments[2]); exit(0)
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var windows: [NSWindow] = []
    var webView: WKWebView!
    var startup: Process?
    var status: NSTextField!
    let boardURL=URL(string:"http://127.0.0.1:6480/")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let mainMenu=NSMenu()
        let item=NSMenuItem(); mainMenu.addItem(item)
        let appMenu=NSMenu(); item.submenu=appMenu
        appMenu.addItem(withTitle:"关于 Crew Tasks",action:#selector(NSApplication.orderFrontStandardAboutPanel(_:)),keyEquivalent:"")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle:"隐藏 Crew Tasks",action:#selector(NSApplication.hide(_:)),keyEquivalent:"h")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle:"退出 Crew Tasks",action:#selector(NSApplication.terminate(_:)),keyEquivalent:"q")
        let viewItem=NSMenuItem(); mainMenu.addItem(viewItem)
        let viewMenu=NSMenu(title:"视图"); viewItem.submenu=viewMenu
        let reload=viewMenu.addItem(withTitle:"刷新任务",action:#selector(reloadPage),keyEquivalent:"r"); reload.target=self
        NSApp.mainMenu=mainMenu
        let window=makeWindow(title:"Crew Tasks · 今日任务",url:nil)
        window.setFrameAutosaveName("CrewTasksMainWindow")
        status=NSTextField(labelWithString:"正在连接本地任务库…")
        status.font=NSFont.systemFont(ofSize:16); status.textColor=NSColor.secondaryLabelColor
        status.translatesAutoresizingMaskIntoConstraints=false
        window.contentView!.addSubview(status)
        NSLayoutConstraint.activate([status.centerXAnchor.constraint(equalTo:window.contentView!.centerXAnchor),status.centerYAnchor.constraint(equalTo:window.contentView!.centerYAnchor)])
        NSApp.activate(ignoringOtherApps:true)
        boot()
    }
    func makeWindow(title:String,url:URL?) -> NSWindow {
        let window=NSWindow(contentRect:NSRect(x:0,y:0,width:1320,height:850),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        window.title=title; window.isReleasedWhenClosed=false; window.minSize=NSSize(width:720,height:520)
        window.center(); window.backgroundColor=NSColor.windowBackgroundColor
        let view=WKWebView(frame:window.contentView!.bounds)
        view.autoresizingMask=[.width,.height]; view.navigationDelegate=self; view.uiDelegate=self
        window.contentView!.addSubview(view)
        if webView == nil { webView=view }
        windows.append(window); window.makeKeyAndOrderFront(nil)
        if let url=url { view.load(URLRequest(url:url)) }
        return window
    }
    func boot() {
        guard let resource=Bundle.main.resourceURL else { fail("找不到应用配置。"); return }
        let config=resource.appendingPathComponent("config.json")
        do {
            let data=try Data(contentsOf:config)
            let settings=try JSONSerialization.jsonObject(with:data) as! [String:String]
            let process=Process(); startup=process
            process.executableURL=URL(fileURLWithPath:settings["python"]!)
            process.arguments=[settings["repo"]!+"/scripts/task-board/bootstrap.py",config.path]
            let errors=Pipe(); process.standardError=errors; process.standardOutput=Pipe()
            process.terminationHandler={ [weak self] process in
                let message=String(data:errors.fileHandleForReading.readDataToEndOfFile(),encoding:.utf8) ?? "本地服务启动失败。"
                DispatchQueue.main.async {
                    if process.terminationStatus==0 {
                        guard let self=self else { return }
                        self.status.stringValue="正在载入任务看板…"
                        self.webView.load(URLRequest(url:self.boardURL))
                        self.windows.first?.makeKeyAndOrderFront(nil)
                        NSApp.activate(ignoringOtherApps:true)
                    }
                    else { self?.fail(message) }
                }
            }
            try process.run()
        } catch { fail("无法启动本地服务：\(error.localizedDescription)") }
    }
    func fail(_ message:String) { status.stringValue=message; status.maximumNumberOfLines=8; status.preferredMaxLayoutWidth=650 }
    @objc func reloadPage() { webView.reload() }
    func webView(_ view:WKWebView,didFinish navigation:WKNavigation!) {
        if view === webView { status.removeFromSuperview() }
    }
    func applicationShouldHandleReopen(_ sender:NSApplication,hasVisibleWindows:Bool) -> Bool {
        if !hasVisibleWindows { windows.first?.makeKeyAndOrderFront(nil) }; return true
    }
    func local(_ url:URL) -> Bool { url.scheme=="http" && ["127.0.0.1","localhost"].contains(url.host ?? "") && [6480,4192].contains(url.port ?? 0) }
    func webView(_ view:WKWebView,decidePolicyFor action:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void) {
        guard let url=action.request.url else { decisionHandler(.cancel); return }
        if local(url) || url.absoluteString=="about:blank" { decisionHandler(.allow) }
        else { decisionHandler(.cancel); NSWorkspace.shared.open(url) }
    }
    func webView(_ view:WKWebView,createWebViewWith configuration:WKWebViewConfiguration,for action:WKNavigationAction,windowFeatures:WKWindowFeatures) -> WKWebView? {
        guard let url=action.request.url else { return nil }
        if local(url) { _=makeWindow(title:"Crew Tasks · 工作台",url:url) }
        else { NSWorkspace.shared.open(url) }
        return nil
    }
    func webView(_ view:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error) {
        let alert=NSAlert(); alert.messageText="无法连接任务看板"; alert.informativeText=error.localizedDescription; alert.addButton(withTitle:"重试")
        if let window=view.window { alert.beginSheetModal(for:window) { _ in view.reload() } }
    }
}
let app=NSApplication.shared
let delegate=AppDelegate(); app.delegate=delegate
app.setActivationPolicy(.regular)
app.run()
