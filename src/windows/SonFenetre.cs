// Son d'une seule application (celle de la fenêtre diffusée), pour le flux OBS.
// Compilé par PowerShell 5.1 (Add-Type) : C# 5 uniquement.
//
// API Windows « process loopback » (Windows 10 version 2004 et plus récent) :
// capture le son joué par un processus et ses sous-processus (Chrome joue son
// son dans un sous-processus), et rien d'autre. Le son est écrit en continu sur
// la sortie standard : PCM 16 bits, 48 000 Hz, stéréo.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace Diffusion
{
    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    // Marqueur exigé par ActivateAudioInterfaceAsync (appel depuis n'importe quel thread).
    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAgileObject
    {
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, [In] ref WaveFormat format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    internal struct WaveFormat
    {
        public ushort FormatTag;
        public ushort Channels;
        public uint SamplesPerSec;
        public uint AvgBytesPerSec;
        public ushort BlockAlign;
        public ushort BitsPerSample;
        public ushort Size;
    }

    public class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation)
        {
            Done.Set();
        }
    }

    public static class SonFenetre
    {
        const string ProcessLoopbackDevice = "VAD\\Process_Loopback";
        const int ActivationTypeProcessLoopback = 1;
        const int IncludeTargetProcessTree = 0;
        const ushort VT_BLOB = 65;
        const uint StreamFlagsLoopback = 0x00020000;
        const uint StreamFlagsEventCallback = 0x00040000;
        const uint StreamFlagsAutoConvertPcm = 0x80000000;
        const uint StreamFlagsSrcDefaultQuality = 0x08000000;
        const uint BufferFlagsSilent = 0x2;
        const int SampleRate = 48000;
        const int Channels = 2;
        const int BytesPerFrame = Channels * 2;

        static readonly Guid IAudioClientId = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        static readonly Guid IAudioCaptureClientId = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
        static extern void ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            IntPtr activationParams,
            IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);

        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

        static int exitCode = 0;

        // Point d'entrée : capture le son de l'application de la fenêtre donnée,
        // jusqu'à ce que l'application Diffusion Écran arrête ce processus.
        public static int Run(long hwnd)
        {
            uint pid;
            GetWindowThreadProcessId(new IntPtr(hwnd), out pid);
            if (pid == 0)
            {
                Console.Error.WriteLine("Fenêtre introuvable.");
                return 2;
            }
            // L'activation se fait hors du thread de PowerShell (STA).
            var thread = new Thread(delegate () { Capture(pid); });
            thread.SetApartmentState(ApartmentState.MTA);
            thread.Start();
            thread.Join();
            return exitCode;
        }

        static IAudioClient Activate(uint pid)
        {
            int paramsSize = 12;
            IntPtr activationParams = Marshal.AllocHGlobal(paramsSize);
            IntPtr propVariant = Marshal.AllocHGlobal(32);
            try
            {
                Marshal.WriteInt32(activationParams, 0, ActivationTypeProcessLoopback);
                Marshal.WriteInt32(activationParams, 4, (int)pid);
                Marshal.WriteInt32(activationParams, 8, IncludeTargetProcessTree);

                for (int i = 0; i < 32; i++) Marshal.WriteByte(propVariant, i, 0);
                Marshal.WriteInt16(propVariant, 0, (short)VT_BLOB);
                Marshal.WriteInt32(propVariant, 8, paramsSize);
                Marshal.WriteIntPtr(propVariant, IntPtr.Size == 8 ? 16 : 12, activationParams);

                var handler = new ActivationHandler();
                IActivateAudioInterfaceAsyncOperation operation;
                ActivateAudioInterfaceAsync(ProcessLoopbackDevice, IAudioClientId, propVariant, handler, out operation);
                if (!handler.Done.WaitOne(5000)) throw new Exception("Pas de réponse de Windows.");
                int hr;
                object client;
                operation.GetActivateResult(out hr, out client);
                if (hr != 0) throw new Exception("Activation refusée (0x" + hr.ToString("X8") + ").");
                return (IAudioClient)client;
            }
            finally
            {
                Marshal.FreeHGlobal(propVariant);
                Marshal.FreeHGlobal(activationParams);
            }
        }

        static void Capture(uint pid)
        {
            try
            {
                var client = Activate(pid);
                var format = new WaveFormat
                {
                    FormatTag = 1, // PCM
                    Channels = Channels,
                    SamplesPerSec = SampleRate,
                    BitsPerSample = 16,
                    BlockAlign = BytesPerFrame,
                    AvgBytesPerSec = SampleRate * BytesPerFrame,
                    Size = 0,
                };
                uint flags = StreamFlagsLoopback | StreamFlagsEventCallback | StreamFlagsAutoConvertPcm | StreamFlagsSrcDefaultQuality;
                Check(client.Initialize(0, flags, 2000000, 0, ref format, IntPtr.Zero), "Initialize");
                var ready = new AutoResetEvent(false);
                Check(client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle()), "SetEventHandle");
                Guid captureId = IAudioCaptureClientId;
                object service;
                Check(client.GetService(ref captureId, out service), "GetService");
                var capture = (IAudioCaptureClient)service;
                Check(client.Start(), "Start");

                Stream output = Console.OpenStandardOutput();
                byte[] buffer = new byte[SampleRate * BytesPerFrame];
                while (true)
                {
                    ready.WaitOne(100);
                    uint packet;
                    while (capture.GetNextPacketSize(out packet) == 0 && packet > 0)
                    {
                        IntPtr data;
                        uint frames, bufferFlags;
                        ulong devicePosition, qpcPosition;
                        Check(capture.GetBuffer(out data, out frames, out bufferFlags, out devicePosition, out qpcPosition), "GetBuffer");
                        int bytes = (int)frames * BytesPerFrame;
                        if (bytes > buffer.Length) buffer = new byte[bytes];
                        if ((bufferFlags & BufferFlagsSilent) != 0) Array.Clear(buffer, 0, bytes);
                        else Marshal.Copy(data, buffer, 0, bytes);
                        capture.ReleaseBuffer(frames);
                        // Si l'application a fermé la sortie, Write lève IOException : fin.
                        output.Write(buffer, 0, bytes);
                    }
                    output.Flush();
                }
            }
            catch (IOException)
            {
                // Sortie fermée par l'application : fin normale.
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                exitCode = 1;
            }
        }

        static void Check(int hr, string step)
        {
            if (hr != 0) throw new Exception(step + " a échoué (0x" + hr.ToString("X8") + ").");
        }
    }
}
