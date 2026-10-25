// Bureaux virtuels de Windows (Windows + Tab), utilisé par bureaux.ps1.
// Compilé par PowerShell 5.1 (Add-Type) : C# 5 uniquement.
//
// Lecture seule pour les fenêtres des autres applications : rien n'est
// déplacé, épinglé ni activé, la disposition des bureaux reste intacte.
// - Liste des bureaux : lue dans le registre, tenu à jour par l'Explorateur.
// - Bureau de chaque fenêtre : IVirtualDesktopManager (API officielle).
// - « Afficher sur tous les bureaux », pour l'écran de projection de
//   l'application uniquement : IVirtualDesktopPinnedApps (API non documentée
//   mais stable depuis Windows 10, celle du menu de Task View).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace Diffusion
{
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b")]
    internal interface IVirtualDesktopManager
    {
        [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow, out int onCurrentDesktop);
        [PreserveSig] int GetWindowDesktopId(IntPtr topLevelWindow, out Guid desktopId);
        [PreserveSig] int MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
    }

    [ComImport, Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")]
    internal class VirtualDesktopManagerClass
    {
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("6D5140C1-7436-11CE-8034-00AA006009FA")]
    internal interface IServiceProvider10
    {
        [return: MarshalAs(UnmanagedType.IUnknown)]
        object QueryService(ref Guid service, ref Guid riid);
    }

    // Seules les premières méthodes sont déclarées (ordre de la table COM).
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("1841C6D7-4F9D-42C0-AF41-8747538F10E5")]
    internal interface IApplicationViewCollection
    {
        [PreserveSig] int GetViews(out IntPtr array);
        [PreserveSig] int GetViewsByZOrder(out IntPtr array);
        [PreserveSig] int GetViewsByAppUserModelId(IntPtr id, out IntPtr array);
        [PreserveSig] int GetViewForHwnd(IntPtr hwnd, out IntPtr view);
        [PreserveSig] int GetViewForApplication(IntPtr application, out IntPtr view);
        [PreserveSig] int GetViewForAppUserModelId(IntPtr id, out IntPtr view);
        [PreserveSig] int GetViewInFocus(out IntPtr view);
        [PreserveSig] int Unknown1(out IntPtr view);
        [PreserveSig] int RefreshCollection();
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("4CE81583-1E4C-4632-A621-07A53543148F")]
    internal interface IVirtualDesktopPinnedApps
    {
        [PreserveSig] int IsAppIdPinned(IntPtr appId, out int pinned);
        [PreserveSig] int PinAppID(IntPtr appId);
        [PreserveSig] int UnpinAppID(IntPtr appId);
        [PreserveSig] int IsViewPinned(IntPtr view, out int pinned);
        [PreserveSig] int PinView(IntPtr view);
        [PreserveSig] int UnpinView(IntPtr view);
    }

    public static class Bureaux
    {
        const string DesktopsKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops";
        static readonly Guid ImmersiveShell = new Guid("C2F03A33-21F5-47FA-B4BB-156362A2F239");
        static readonly Guid PinnedAppsService = new Guid("B5A399E7-1C87-46B8-88E9-FC5747B171BD");

        delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

        const uint GW_OWNER = 4;
        const int GWL_EXSTYLE = -20;
        const int WS_EX_TOOLWINDOW = 0x80;
        const int WS_EX_APPWINDOW = 0x40000;
        const int DWMWA_CLOAKED = 14;
        const int DWM_CLOAKED_SHELL = 2; // fenêtre d'un autre bureau

        static IVirtualDesktopManager manager;
        static IApplicationViewCollection views;
        static IVirtualDesktopPinnedApps pinnedApps;

        static IVirtualDesktopManager Manager()
        {
            if (manager == null) manager = (IVirtualDesktopManager)new VirtualDesktopManagerClass();
            return manager;
        }

        // Services de l'Explorateur : à recréer si l'Explorateur redémarre.
        static bool EnsureShell()
        {
            if (views != null && pinnedApps != null) return true;
            try
            {
                var shell = (IServiceProvider10)Activator.CreateInstance(Type.GetTypeFromCLSID(ImmersiveShell));
                Guid viewsId = typeof(IApplicationViewCollection).GUID;
                views = (IApplicationViewCollection)shell.QueryService(ref viewsId, ref viewsId);
                Guid pinnedService = PinnedAppsService;
                Guid pinnedId = typeof(IVirtualDesktopPinnedApps).GUID;
                pinnedApps = (IVirtualDesktopPinnedApps)shell.QueryService(ref pinnedService, ref pinnedId);
                return true;
            }
            catch
            {
                views = null;
                pinnedApps = null;
                return false;
            }
        }

        static IntPtr ViewFor(IntPtr hwnd)
        {
            if (!EnsureShell()) return IntPtr.Zero;
            IntPtr view;
            if (views.GetViewForHwnd(hwnd, out view) == 0 && view != IntPtr.Zero) return view;
            views.RefreshCollection();
            if (views.GetViewForHwnd(hwnd, out view) == 0 && view != IntPtr.Zero) return view;
            return IntPtr.Zero;
        }

        static bool IsPinned(IntPtr hwnd)
        {
            IntPtr view = ViewFor(hwnd);
            if (view == IntPtr.Zero) return false;
            try
            {
                int pinned;
                return pinnedApps.IsViewPinned(view, out pinned) == 0 && pinned != 0;
            }
            finally
            {
                Marshal.Release(view);
            }
        }

        // --- Bureaux --------------------------------------------------------

        static Guid ReadGuid(RegistryKey key, string name)
        {
            if (key == null) return Guid.Empty;
            var bytes = key.GetValue(name) as byte[];
            return bytes != null && bytes.Length == 16 ? new Guid(bytes) : Guid.Empty;
        }

        static List<Guid> DesktopIds(out Guid current)
        {
            var ids = new List<Guid>();
            current = Guid.Empty;
            using (var key = Registry.CurrentUser.OpenSubKey(DesktopsKey))
            {
                if (key != null)
                {
                    var bytes = key.GetValue("VirtualDesktopIDs") as byte[];
                    if (bytes != null)
                    {
                        for (int i = 0; i + 16 <= bytes.Length; i += 16)
                        {
                            var one = new byte[16];
                            Array.Copy(bytes, i, one, 0, 16);
                            ids.Add(new Guid(one));
                        }
                    }
                    current = ReadGuid(key, "CurrentVirtualDesktop");
                }
            }
            if (current == Guid.Empty)
            {
                // Windows 10 : le bureau actuel est rangé par session.
                int session = Process.GetCurrentProcess().SessionId;
                string path = @"Software\Microsoft\Windows\CurrentVersion\Explorer\SessionInfo\" + session + @"\VirtualDesktops";
                using (var key = Registry.CurrentUser.OpenSubKey(path))
                {
                    current = ReadGuid(key, "CurrentVirtualDesktop");
                }
            }
            return ids;
        }

        static string DesktopName(Guid id)
        {
            using (var key = Registry.CurrentUser.OpenSubKey(DesktopsKey + @"\Desktops\" + id.ToString("B")))
            {
                var name = key == null ? null : key.GetValue("Name") as string;
                return string.IsNullOrEmpty(name) ? null : name;
            }
        }

        // --- Fenêtres -------------------------------------------------------

        class WindowInfo
        {
            public IntPtr Hwnd;
            public string Title;
            public string Process;
            public Guid Desktop;
            public bool OnCurrent;
            public bool Pinned;
            public bool Minimized;
        }

        static string ClassOf(IntPtr hwnd)
        {
            var name = new StringBuilder(256);
            GetClassName(hwnd, name, name.Capacity);
            return name.ToString();
        }

        static List<WindowInfo> Windows(int ownProcessId)
        {
            var result = new List<WindowInfo>();
            var mgr = Manager();
            EnumWindows(delegate (IntPtr hwnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return true;
                int length = GetWindowTextLength(hwnd);
                if (length == 0) return true;
                int exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
                if ((exStyle & WS_EX_TOOLWINDOW) != 0 && (exStyle & WS_EX_APPWINDOW) == 0) return true;
                int cloaked;
                if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0 && cloaked != DWM_CLOAKED_SHELL) return true;
                string cls = ClassOf(hwnd);
                if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") return true;
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if ((int)pid == ownProcessId) return true;

                Guid desktop;
                if (mgr.GetWindowDesktopId(hwnd, out desktop) != 0) return true;
                int onCurrent;
                if (mgr.IsWindowOnCurrentVirtualDesktop(hwnd, out onCurrent) != 0) onCurrent = 0;

                var title = new StringBuilder(length + 1);
                GetWindowText(hwnd, title, title.Capacity);
                string process = "";
                try { process = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
                catch { }

                result.Add(new WindowInfo
                {
                    Hwnd = hwnd,
                    Title = title.ToString(),
                    Process = process,
                    Desktop = desktop,
                    OnCurrent = onCurrent != 0,
                    Pinned = IsPinned(hwnd),
                    Minimized = IsIconic(hwnd),
                });
                return true;
            }, IntPtr.Zero);
            return result;
        }

        // --- Commandes (réponses en JSON) ----------------------------------

        static string Json(string value)
        {
            if (value == null) return "null";
            var sb = new StringBuilder("\"");
            foreach (char c in value)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        static string Error(string message)
        {
            return "{\"ok\":false,\"error\":" + Json(message) + "}";
        }

        public static string List(int ownProcessId)
        {
            Guid current;
            var ids = DesktopIds(out current);
            var windows = Windows(ownProcessId);

            // Bureau actuel introuvable dans le registre : on le déduit des fenêtres.
            if (current == Guid.Empty)
            {
                foreach (var w in windows)
                {
                    if (w.OnCurrent && !w.Pinned && w.Desktop != Guid.Empty) { current = w.Desktop; break; }
                }
            }
            // Un seul bureau jamais créé : le registre ne liste encore rien.
            if (ids.Count == 0 && current != Guid.Empty) ids.Add(current);

            var sb = new StringBuilder("{\"ok\":true,\"pinAvailable\":");
            sb.Append(EnsureShell() ? "true" : "false");
            sb.Append(",\"current\":").Append(Json(current == Guid.Empty ? null : current.ToString()));
            sb.Append(",\"desktops\":[");
            for (int i = 0; i < ids.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append("{\"id\":").Append(Json(ids[i].ToString()))
                  .Append(",\"index\":").Append(i + 1)
                  .Append(",\"name\":").Append(Json(DesktopName(ids[i])))
                  .Append(",\"current\":").Append(ids[i] == current ? "true" : "false")
                  .Append('}');
            }
            sb.Append("],\"windows\":[");
            for (int i = 0; i < windows.Count; i++)
            {
                var w = windows[i];
                if (i > 0) sb.Append(',');
                sb.Append("{\"hwnd\":").Append(Json(w.Hwnd.ToInt64().ToString()))
                  .Append(",\"title\":").Append(Json(w.Title))
                  .Append(",\"process\":").Append(Json(w.Process))
                  .Append(",\"desktop\":").Append(Json(w.Desktop.ToString()))
                  .Append(",\"onCurrent\":").Append(w.OnCurrent ? "true" : "false")
                  .Append(",\"pinned\":").Append(w.Pinned ? "true" : "false")
                  .Append(",\"minimized\":").Append(w.Minimized ? "true" : "false")
                  .Append('}');
            }
            return sb.Append("]}").ToString();
        }

        // Affiche une fenêtre de l'application sur tous les bureaux.
        public static string Pin(long hwnd)
        {
            IntPtr view = ViewFor(new IntPtr(hwnd));
            if (view == IntPtr.Zero)
            {
                // L'Explorateur a peut-être redémarré : on reconnecte une fois.
                views = null;
                pinnedApps = null;
                view = ViewFor(new IntPtr(hwnd));
            }
            if (view == IntPtr.Zero) return Error("Fenêtre introuvable pour le gestionnaire de bureaux.");
            try
            {
                int pinned;
                if (pinnedApps.IsViewPinned(view, out pinned) != 0) pinned = 0;
                bool wasPinned = pinned != 0;
                int hr = wasPinned ? 0 : pinnedApps.PinView(view);
                if (hr != 0) return Error("Échec (code 0x" + hr.ToString("X8") + ").");
                return "{\"ok\":true,\"wasPinned\":" + (wasPinned ? "true" : "false") + "}";
            }
            finally
            {
                Marshal.Release(view);
            }
        }
    }
}
