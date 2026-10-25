// Bureaux virtuels de Windows (Windows + Tab), utilisé par bureaux.ps1.
// Compilé par PowerShell 5.1 (Add-Type) : C# 5 uniquement.
//
// - Lecture : liste des bureaux et des fenêtres (rien n'est modifié).
// - Diffusion d'une fenêtre (Place / Restore) : la fenêtre choisie est rendue
//   visible sur le bureau affiché puis placée en plein écran sur l'écran de
//   projection ; à l'arrêt, elle retrouve exactement sa place d'origine. Aucune
//   touche ni aucun clic n'est simulé, et la fenêtre n'est jamais activée.
// - Liste des bureaux : lue dans le registre, tenu à jour par l'Explorateur.
// - Bureau de chaque fenêtre : IVirtualDesktopManager (API officielle).
// - Fenêtres « affichées sur tous les bureaux » : IVirtualDesktopPinnedApps
//   (API non documentée mais stable depuis Windows 10), pour ne pas les
//   lister deux fois.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
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
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT placement);
        [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT placement);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        [StructLayout(LayoutKind.Sequential)]
        struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        struct WINDOWPLACEMENT
        {
            public int Length;
            public int Flags;
            public int ShowCmd;
            public POINT MinPosition;
            public POINT MaxPosition;
            public RECT NormalPosition;
        }

        const uint GW_OWNER = 4;
        const int GWL_EXSTYLE = -20;
        const int WS_EX_TOOLWINDOW = 0x80;
        const int WS_EX_APPWINDOW = 0x40000;
        const int DWMWA_CLOAKED = 14;
        const int DWM_CLOAKED_SHELL = 2; // fenêtre d'un autre bureau
        const int WS_EX_TOPMOST = 0x8;
        const int SW_SHOWNORMAL = 1;
        const int SW_SHOWNOACTIVATE = 4;
        const uint SWP_NOSIZE = 0x1;
        const uint SWP_NOMOVE = 0x2;
        const uint SWP_NOACTIVATE = 0x10;
        const uint SWP_SHOWWINDOW = 0x40;
        const uint SWP_NOOWNERZORDER = 0x200;
        static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
        static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

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

        // --- Diffusion d'une fenêtre sur l'écran de projection ---------------

        class Saved
        {
            public WINDOWPLACEMENT Placement;
            public RECT Rect;
            public bool WasPinned;
            public bool PinnedByUs;
            public bool WasTopmost;
            public Guid Desktop;
        }

        static readonly Dictionary<long, Saved> saved = new Dictionary<long, Saved>();

        // Coordonnées en vrais pixels, comme celles envoyées par l'application.
        public static void InitDpi()
        {
            try
            {
                if (SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != IntPtr.Zero) return;
            }
            catch (EntryPointNotFoundException) { }
            try { SetProcessDPIAware(); }
            catch { }
        }

        static bool SetPinned(IntPtr hwnd, bool pin)
        {
            IntPtr view = ViewFor(hwnd);
            if (view == IntPtr.Zero)
            {
                views = null;
                pinnedApps = null;
                view = ViewFor(hwnd);
            }
            if (view == IntPtr.Zero) return false;
            try
            {
                int pinned;
                if (pinnedApps.IsViewPinned(view, out pinned) != 0) pinned = 0;
                if (pin == (pinned != 0)) return true;
                return (pin ? pinnedApps.PinView(view) : pinnedApps.UnpinView(view)) == 0;
            }
            finally
            {
                Marshal.Release(view);
            }
        }

        // Ramène la fenêtre à l'état « normal » (ni réduite, ni agrandie) sans
        // l'activer, pour pouvoir lui donner une position et une taille.
        static void MakeNormal(IntPtr hwnd)
        {
            if (!IsIconic(hwnd) && !IsZoomed(hwnd)) return;
            var wp = new WINDOWPLACEMENT();
            wp.Length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
            GetWindowPlacement(hwnd, ref wp);
            wp.Flags = 0;
            wp.ShowCmd = SW_SHOWNOACTIVATE;
            SetWindowPlacement(hwnd, ref wp);
        }

        public static string Place(long handle, int x, int y, int width, int height)
        {
            var hwnd = new IntPtr(handle);
            if (!IsWindow(hwnd)) return "{\"ok\":false,\"error\":\"Cette fenêtre n'existe plus.\"}";

            if (!saved.ContainsKey(handle))
            {
                var s = new Saved();
                s.Placement.Length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
                GetWindowPlacement(hwnd, ref s.Placement);
                GetWindowRect(hwnd, out s.Rect);
                s.WasPinned = IsPinned(hwnd);
                s.WasTopmost = (GetWindowLong(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
                Guid desktop;
                s.Desktop = Manager().GetWindowDesktopId(hwnd, out desktop) == 0 ? desktop : Guid.Empty;
                saved[handle] = s;
            }

            // Fenêtre d'un autre bureau : Windows ne la dessine pas tant que ce
            // bureau n'est pas affiché. Seulement dans ce cas, on la rend visible
            // ici le temps de la diffusion ; sinon aucun bureau n'est touché.
            var info = saved[handle];
            int onCurrent;
            if (Manager().IsWindowOnCurrentVirtualDesktop(hwnd, out onCurrent) != 0) onCurrent = 1;
            if (onCurrent == 0 && !info.WasPinned && !info.PinnedByUs)
            {
                info.PinnedByUs = SetPinned(hwnd, true);
            }
            MakeNormal(hwnd);
            // Au-dessus de la barre des tâches de l'écran de projection.
            SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER);
            // Certaines applications corrigent leur taille juste après : on insiste une fois.
            Thread.Sleep(150);
            SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER);
            return "{\"ok\":true,\"otherDesktop\":" + (info.PinnedByUs ? "true" : "false") + "}";
        }

        public static string Restore(long handle)
        {
            var hwnd = new IntPtr(handle);
            Saved s;
            if (!saved.TryGetValue(handle, out s)) return "{\"ok\":true}";
            saved.Remove(handle);
            if (!IsWindow(hwnd)) return "{\"ok\":true}";

            if (!s.WasTopmost)
            {
                SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
            }
            // Position et taille d'origine (une fenêtre en plein écran revient
            // exactement sur son écran), puis son état réduit/agrandi.
            var r = s.Rect;
            SetWindowPos(hwnd, IntPtr.Zero, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top,
                SWP_NOACTIVATE | SWP_NOOWNERZORDER | 0x4 /* SWP_NOZORDER */);
            if (s.Placement.ShowCmd != SW_SHOWNORMAL)
            {
                var wp = s.Placement;
                SetWindowPlacement(hwnd, ref wp);
            }
            if (s.PinnedByUs)
            {
                SetPinned(hwnd, false);
                // Retour sur son bureau d'origine (si Windows le permet).
                if (s.Desktop != Guid.Empty)
                {
                    Guid desktop = s.Desktop;
                    Manager().MoveWindowToDesktop(hwnd, ref desktop);
                }
            }
            return "{\"ok\":true}";
        }

        public static string Alive(long handle)
        {
            return IsWindow(new IntPtr(handle)) ? "{\"ok\":true,\"alive\":true}" : "{\"ok\":true,\"alive\":false}";
        }
    }
}
