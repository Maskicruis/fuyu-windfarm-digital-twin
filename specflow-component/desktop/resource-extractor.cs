// Native extended-length paths work on Windows PowerShell 5.1 without changing
// the machine's LongPathsEnabled registry setting or requiring administrator rights.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace SpecFlow {
    public static class ResourceExtractor {
        const uint Missing = 0xffffffff, DirectoryFlag = 0x10, ReparseFlag = 0x400;
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern uint GetFileAttributesW(string path);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool CreateDirectoryW(string path, IntPtr security);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool MoveFileExW(string source, string destination, uint flags);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool DeleteFileW(string path);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool SetFileTime(SafeFileHandle file, IntPtr created, IntPtr accessed, ref long written);

        static Exception NativeError(string action, string path) {
            int code = Marshal.GetLastWin32Error();
            return new IOException(action + " (Win32 " + code + "): " + path + " - " + new Win32Exception(code).Message);
        }
        static string Extended(string path) {
            if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
            if (path.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + path.Substring(2);
            return @"\\?\" + path;
        }
        static uint Attributes(string path) {
            uint value = GetFileAttributesW(path);
            if (value == Missing) {
                int error = Marshal.GetLastWin32Error();
                if (error != 2 && error != 3) throw NativeError("Inspect path", path);
            }
            return value;
        }
        static void Folder(string path, HashSet<string> known) {
            if (known.Contains(path)) return;
            uint value = Attributes(path);
            if (value != Missing) {
                if ((value & DirectoryFlag) == 0 || (value & ReparseFlag) != 0) throw new IOException("Unsafe archive directory: " + path);
                known.Add(path); return;
            }
            int separator = path.LastIndexOf('\\');
            if (separator < 4) throw new IOException("Destination volume is unavailable: " + path);
            string parent = path.Substring(0, separator);
            if (parent.EndsWith(":")) parent += "\\";
            Folder(parent, known);
            if (!CreateDirectoryW(path, IntPtr.Zero)) throw NativeError("Create directory", path);
            known.Add(path);
        }
        static string EntryPath(ZipArchiveEntry entry) {
            string name = entry.FullName.Replace('\\', '/');
            if (name.Length == 0 || name.StartsWith("/") || name.IndexOfAny(new char[]{':','\0','<','>','"','|','?','*'}) >= 0)
                throw new IOException("Archive entry escapes destination or has an invalid path: " + name);
            foreach (string part in name.TrimEnd('/').Split('/')) {
                if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" "))
                    throw new IOException("Archive entry escapes destination or has an invalid path: " + name);
                string device = part.Split('.')[0].ToUpperInvariant();
                if (device == "CON" || device == "PRN" || device == "AUX" || device == "NUL" ||
                    (device.Length == 4 && (device.StartsWith("COM") || device.StartsWith("LPT")) && device[3] >= '1' && device[3] <= '9'))
                    throw new IOException("Archive entry uses a reserved device name: " + name);
            }
            if (((entry.ExternalAttributes >> 16) & 0xf000) == 0xa000) throw new IOException("Archive symbolic links are not allowed: " + name);
            return name;
        }
        public static void Extract(string archivePath, string destination, bool preserveWorkspace) {
            // Node supplies an absolute destination. Avoid legacy .NET path
            // normalization for individual entries, which may exceed MAX_PATH.
            if (String.IsNullOrEmpty(destination) || !Path.IsPathRooted(destination)) throw new IOException("Absolute destination required");
            string root = Extended(destination.Replace('/', '\\').TrimEnd('\\')) + "\\";
            var folders = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            Folder(root.TrimEnd('\\'), folders);
            using (var archiveFile = CreateFileW(Extended(archivePath), 0x80000000, 1, IntPtr.Zero, 3, 0x80, IntPtr.Zero)) {
                if (archiveFile.IsInvalid) throw NativeError("Open archive", archivePath);
                using (var archiveStream = new FileStream(archiveFile, FileAccess.Read))
                using (var archive = new ZipArchive(archiveStream, ZipArchiveMode.Read)) {
                    // Validate all names before writing even the first entry.
                    foreach (var entry in archive.Entries) EntryPath(entry);
                    int current = 0, total = archive.Entries.Count;
                    foreach (var entry in archive.Entries) {
                        string relative = EntryPath(entry), target = root + relative.Replace('/', '\\');
                        current++;
                        if (current == 1 || current % 200 == 0) Console.WriteLine("SF_EXTRACT " + current + "/" + total);
                        if (relative.EndsWith("/")) { Folder(target.TrimEnd('\\'), folders); continue; }
                        uint existing = Attributes(target);
                        if (existing != Missing && (existing & (DirectoryFlag | ReparseFlag)) != 0) throw new IOException("Unsafe archive target: " + target);
                        if (preserveWorkspace && relative.StartsWith("workspace/", StringComparison.OrdinalIgnoreCase) && existing != Missing) continue;
                        string parent = target.Substring(0, target.LastIndexOf('\\'));
                        Folder(parent, folders);
                        // A short sibling name avoids making already long leaf
                        // names longer. Replace only after the complete copy succeeds.
                        string temporary = parent + "\\.sf-" + Guid.NewGuid().ToString("N") + ".tmp";
                        try {
                            using (var handle = CreateFileW(temporary, 0x40000000, 0, IntPtr.Zero, 1, 0x80, IntPtr.Zero)) {
                                if (handle.IsInvalid) throw NativeError("Create temporary file", target);
                                using (var output = new FileStream(handle, FileAccess.Write, 131072)) {
                                    using (var input = entry.Open()) input.CopyTo(output, 131072);
                                    output.Flush();
                                    long stamp = entry.LastWriteTime.UtcDateTime.ToFileTimeUtc();
                                    if (!SetFileTime(handle, IntPtr.Zero, IntPtr.Zero, ref stamp)) throw NativeError("Set file timestamp", target);
                                }
                            }
                            if (!MoveFileExW(temporary, target, 0x1 | 0x8)) throw NativeError("Install file", target);
                        } finally {
                            // A failed copy never removes the previous destination.
                            DeleteFileW(temporary);
                        }
                    }
                    Console.WriteLine("SF_EXTRACT " + total + "/" + total);
                }
            }
        }
    }
}
