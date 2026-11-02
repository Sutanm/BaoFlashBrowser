using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
class OcrWorker {
 #if TESSERACT53
 const string Tess="libtesseract-5.dll", Lept="liblept-5.dll";
#else
 const string Tess="tesseract50.dll", Lept="leptonica-1.82.0.dll";
#endif
 [DllImport(Tess,CallingConvention=CallingConvention.Cdecl)] static extern IntPtr TessVersion();
 [DllImport(Tess,CallingConvention=CallingConvention.Cdecl)] static extern IntPtr TessBaseAPICreate();
 [DllImport(Tess,CallingConvention=CallingConvention.Cdecl)] static extern int TessBaseAPIInit3(IntPtr api,string path,string lang);
 [DllImport(Tess,CallingConvention=CallingConvention.Cdecl)] static extern void TessBaseAPISetPageSegMode(IntPtr api,int mode);
 [DllImport(Tess,CallingConvention=CallingConvention.Cdecl)] static extern void TessBaseAPISetImage2(IntPtr api,IntPtr pix);
 [DllImport(Tess,CallingConvention=CallingConvention.Cdecl)] static extern IntPtr TessBaseAPIGetUTF8Text(IntPtr api);
 [DllImport(Tess,CallingConvention=CallingConvention.Cdecl)] static extern void TessDeleteText(IntPtr text);
 [DllImport(Tess,CallingConvention=CallingConvention.Cdecl)] static extern void TessBaseAPIClear(IntPtr api);
 [DllImport(Tess,CallingConvention=CallingConvention.Cdecl)] static extern void TessBaseAPIDelete(IntPtr api);
 [DllImport(Lept,CallingConvention=CallingConvention.Cdecl)] static extern IntPtr pixReadMem(byte[] data,UIntPtr size);
 [DllImport(Lept,CallingConvention=CallingConvention.Cdecl)] static extern void pixDestroy(ref IntPtr pix);
 static string Utf8(IntPtr p) {int n=0;while(Marshal.ReadByte(p,n)!=0)n++;byte[] b=new byte[n];Marshal.Copy(p,b,0,n);return Encoding.UTF8.GetString(b);}
 static void Main(string[] args) {
  if(IntPtr.Size != 4) throw new Exception("Worker must be compiled as x86");
  Console.OutputEncoding=new UTF8Encoding(false);
  var timer=Stopwatch.StartNew();IntPtr api=TessBaseAPICreate();
  if(TessBaseAPIInit3(api,args[0],"chi_sim+eng")!=0)throw new Exception("model init failed");
  Console.WriteLine("READY\t"+IntPtr.Size+"\t"+Utf8(TessVersion())+"\t"+timer.Elapsed.TotalMilliseconds);
  string line;
  while((line=Console.ReadLine())!=null) {
   IntPtr pix=IntPtr.Zero,text=IntPtr.Zero;
   try {
    string[] parts=line.Split('\t');string file=Encoding.UTF8.GetString(Convert.FromBase64String(parts[0]));
    timer.Restart();byte[] bytes=File.ReadAllBytes(file);pix=pixReadMem(bytes,(UIntPtr)bytes.Length);
    if(pix==IntPtr.Zero)throw new Exception("decode failed");
    TessBaseAPISetPageSegMode(api,int.Parse(parts[1]));TessBaseAPISetImage2(api,pix);text=TessBaseAPIGetUTF8Text(api);
    string result=Utf8(text);double ms=timer.Elapsed.TotalMilliseconds;
    Console.WriteLine("OK\t"+ms+"\t"+Convert.ToBase64String(Encoding.UTF8.GetBytes(result)));
   }catch(Exception e){Console.WriteLine("ERR\t"+Convert.ToBase64String(Encoding.UTF8.GetBytes(e.Message)));}
   finally {if(text!=IntPtr.Zero)TessDeleteText(text);if(pix!=IntPtr.Zero)pixDestroy(ref pix);TessBaseAPIClear(api);}
  }
  TessBaseAPIDelete(api);
 }
}
