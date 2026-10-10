// SAASEmpire Sync: the launcher launchd runs for com.saasempiree.app-sync.
//
// Why an app: a launchd job cannot read ~/Documents (TCC) unless the process macOS holds
// "responsible" for it has the grant. This bundle (com.saasempiree.sync, signed with the stable
// "SAASEmpire Local Signing" identity so the grant survives rebuilds) is that process: it spawns
// node/git as CHILDREN (posix_spawn, not exec), and children inherit its TCC responsibility.
//
//   SAASEmpireSync <program> [args...]   check ~/Documents access, then run program, return its status
//   SAASEmpireSync                       (opened from Finder/`open`) touch ~/Documents so macOS asks
//                                        for the grant, report the result, quit
import Foundation

let home = FileManager.default.homeDirectoryForCurrentUser.path
let probeDir = "\(home)/Documents/SAASEmpiree"
let logPath = "\(home)/Library/Logs/SAASEmpire/app-sync.log"
let fdaHint = "System Settings > Privacy & Security > Full Disk Access: add ~/Library/Application Support/SAASEmpire/SAASEmpire Sync.app (or allow its Documents prompt)"

func log(_ s: String) {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm:ss"; f.timeZone = TimeZone(identifier: "UTC")
    let line = "\(f.string(from: Date())) [sync] \(s)\n"
    try? FileManager.default.createDirectory(atPath: (logPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    if let h = FileHandle(forWritingAtPath: logPath) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile() }
    else { FileManager.default.createFile(atPath: logPath, contents: line.data(using: .utf8)) }
}

func notify(_ title: String, _ message: String) {
    let esc = { (s: String) in s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-e", "display notification \"\(esc(message))\" with title \"\(esc(title))\" sound name \"Basso\""]
    try? p.run(); p.waitUntilExit()
}

// Reading the directory is what triggers (or checks) the TCC Documents decision.
func documentsAccess() -> (ok: Bool, error: String) {
    do { _ = try FileManager.default.contentsOfDirectory(atPath: probeDir); return (true, "") }
    catch { return (false, (error as NSError).localizedDescription) }
}

let args = Array(CommandLine.arguments.dropFirst()).filter { !$0.hasPrefix("-psn_") }

if args.isEmpty {
    let r = documentsAccess()
    log(r.ok ? "probe: ~/Documents access OK" : "probe: NO access to ~/Documents (\(r.error))")
    notify("SAASEmpire Sync", r.ok ? "Access to ~/Documents OK: installed apps now sync to GitHub automatically."
                                   : "No access to ~/Documents. \(fdaHint)")
    exit(r.ok ? 0 : 1)
}

let access = documentsAccess()
if !access.ok {
    // Notify at most every 6 h (launchd runs us every 10 min); the stamp lives outside ~/Documents.
    let stamp = "\(home)/Library/Application Support/SAASEmpire/ship/.no-documents-access"
    let last = (try? FileManager.default.attributesOfItem(atPath: stamp)[.modificationDate] as? Date) ?? .distantPast
    log("NO access to ~/Documents (\(access.error)); nothing synced. \(fdaHint)")
    if Date().timeIntervalSince(last) > 6 * 3600 {
        notify("SAASEmpire Sync needs access to Documents", fdaHint)
        try? FileManager.default.createDirectory(atPath: (stamp as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: stamp, contents: Data())
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: stamp)
    }
    exit(0) // not a crash: launchd keeps the normal schedule
}
try? FileManager.default.removeItem(atPath: "\(home)/Library/Application Support/SAASEmpire/ship/.no-documents-access")

let child = Process()
child.executableURL = URL(fileURLWithPath: args[0])
child.arguments = Array(args.dropFirst())
child.standardInput = FileHandle.nullDevice // stdout/stderr: inherited (launchd sends them to the log)
do { try child.run() } catch {
    log("cannot start \(args[0]): \(error.localizedDescription)")
    notify("SAASEmpire Sync failed", "cannot start \(args[0])")
    exit(127)
}
child.waitUntilExit()
exit(child.terminationStatus)
