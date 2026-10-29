using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace WebNav {
    public sealed class TrayHost : ApplicationContext {
        readonly NotifyIcon icon = new NotifyIcon();
        readonly ContextMenuStrip menu = new ContextMenuStrip();
        readonly ToolStripMenuItem status = new ToolStripMenuItem("小站 · LittleDock · 启动中");
        readonly ToolStripMenuItem sessions = new ToolStripMenuItem("正在读取连接状态");
        readonly ToolStripMenuItem open = new ToolStripMenuItem("打开主页");
        readonly ToolStripMenuItem startup = new ToolStripMenuItem("开机启动");
        readonly ToolStripMenuItem restart = new ToolStripMenuItem("重启");
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly ConcurrentQueue<string> messages = new ConcurrentQueue<string>();
        readonly Icon runningIcon;
        readonly Icon waitingIcon;
        readonly Icon failedIcon;
        bool ending;
        string lastError = "";
        [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);

        static Icon MakeIcon(Color color, string brandImagePath) {
            using (var bitmap = new Bitmap(32, 32)) {
                using (var graphics = Graphics.FromImage(bitmap)) {
                    graphics.Clear(Color.Transparent);
                    graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                    graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    using (var background = new SolidBrush(Color.FromArgb(232, 238, 236))) graphics.FillEllipse(background, 0, 0, 30, 30);
                    try {
                        using (var mark = Image.FromFile(brandImagePath)) graphics.DrawImage(mark, 1, 1, 28, 28);
                    } catch {
                        // A missing optional image must not prevent access to the tray controls.
                        using (var pen = new Pen(Color.FromArgb(49, 88, 75), 3)) graphics.DrawRectangle(pen, 7, 7, 15, 15);
                    }
                    using (var outline = new SolidBrush(Color.FromArgb(232, 238, 236))) graphics.FillEllipse(outline, 19, 19, 13, 13);
                    using (var brush = new SolidBrush(color)) graphics.FillEllipse(brush, 20, 20, 12, 12);
                }
                IntPtr handle = bitmap.GetHicon();
                try { return (Icon)Icon.FromHandle(handle).Clone(); } finally { DestroyIcon(handle); }
            }
        }
        static void Emit(string value) { Console.WriteLine(value); Console.Out.Flush(); }
        TrayHost(string brandImagePath) {
            runningIcon = MakeIcon(Color.FromArgb(83, 139, 108), brandImagePath);
            waitingIcon = MakeIcon(Color.FromArgb(196, 152, 66), brandImagePath);
            failedIcon = MakeIcon(Color.FromArgb(194, 84, 76), brandImagePath);
            menu.Font = new Font("Microsoft YaHei UI", 10);
            menu.ShowImageMargin = false; menu.ShowCheckMargin = true;
            status.Enabled = false;
            sessions.Enabled = false; menu.Items.Add(status); menu.Items.Add(sessions); menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(open); menu.Items.Add(startup); menu.Items.Add(restart);
            menu.Items.Add(new ToolStripSeparator()); menu.Items.Add("退出", null, (s, e) => { Emit("exit"); restart.Enabled = false; });
            open.Enabled = false; restart.Enabled = false;
            open.Click += (s, e) => Emit("open");
            startup.Click += (s, e) => { startup.Enabled = false; Emit("startup"); };
            restart.Click += (s, e) => { restart.Enabled = false; Emit("restart"); };
            icon.Icon = waitingIcon; icon.Text = "小站 · LittleDock · 启动中";
            icon.ContextMenuStrip = menu; icon.Visible = true;
            icon.DoubleClick += (s, e) => { if (open.Enabled) Emit("open"); };
            // Reading stdin on a background thread avoids blocking the native menu loop.
            var reader = new Thread(() => {
                try { string line; while ((line = Console.ReadLine()) != null) messages.Enqueue(line); } catch { }
                messages.Enqueue("{\"type\":\"exit\"}");
            });
            reader.IsBackground = true; reader.Start();
            timer.Interval = 100;
            timer.Tick += (s, e) => Drain(); timer.Start();
            Emit("ready");
        }
        void Drain() {
            string line;
            while (messages.TryDequeue(out line)) {
                try {
                    var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
                    string type = Convert.ToString(data["type"]);
                    if (type == "exit") { ExitThread(); return; }
                    if (type == "notice") { Notice(Convert.ToString(data["message"])); continue; }
                    if (type != "state") continue;
                    string state = Convert.ToString(data["state"]);
                    string label = state == "running" ? "运行中" : state == "failed" ? "启动失败" : state == "stopping" ? "正在退出" : state == "restarting" ? "正在重启" : "启动中";
                    status.Text = "小站 · LittleDock · " + label;
                    sessions.Text = data.ContainsKey("sessionSummary") ? Convert.ToString(data["sessionSummary"]) : "正在读取连接状态";
                    sessions.Visible = state == "running";
                    string tooltip = status.Text + (state == "running" ? "\n" + sessions.Text : "");
                    icon.Text = tooltip.Length > 63 ? tooltip.Substring(0, 63) : tooltip;
                    icon.Icon = state == "running" ? runningIcon : state == "failed" ? failedIcon : waitingIcon;
                    open.Enabled = state == "running";
                    restart.Enabled = state == "running" || state == "failed";
                    startup.Enabled = state != "stopping"; startup.Checked = Convert.ToBoolean(data["autoStart"]);
                    string error = data.ContainsKey("error") ? Convert.ToString(data["error"]) : "";
                    if (error != "" && error != lastError) Notice(error);
                    lastError = error;
                } catch { /* A malformed parent message must not crash the tray. */ }
            }
        }
        void Notice(string message) { icon.ShowBalloonTip(7000, "小站 · LittleDock", message, ToolTipIcon.Warning); }
        protected override void ExitThreadCore() {
            if (ending) return; ending = true;
            timer.Stop(); timer.Dispose(); icon.Visible = false; icon.Dispose(); menu.Dispose();
            runningIcon.Dispose(); waitingIcon.Dispose(); failedIcon.Dispose(); base.ExitThreadCore();
        }
        public static void Run(string brandImagePath) { Application.EnableVisualStyles(); using (var context = new TrayHost(brandImagePath)) Application.Run(context); }
    }
}
