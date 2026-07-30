#include <windows.h>
#include <stdio.h>

static HHOOK g_hHook = NULL;

LRESULT CALLBACK MouseProc(int nCode, WPARAM wParam, LPARAM lParam)
{
    if (nCode >= 0 && wParam == WM_MOUSEWHEEL)
    {
        if (GetAsyncKeyState(VK_CONTROL) & 0x8000)
        {
            MSLLHOOKSTRUCT *p = (MSLLHOOKSTRUCT *)lParam;
            short delta = GET_WHEEL_DELTA_WPARAM(p->mouseData);
            if (delta > 0)
                printf("ZOOM_IN\n");
            else
                printf("ZOOM_OUT\n");
            fflush(stdout);
            return 1;
        }
    }
    return CallNextHookEx(g_hHook, nCode, wParam, lParam);
}

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int nCmdShow)
{
    (void)hPrevInstance;
    (void)lpCmdLine;
    (void)nCmdShow;

    SetConsoleCP(65001);
    SetConsoleOutputCP(65001);

    g_hHook = SetWindowsHookEx(WH_MOUSE_LL, MouseProc, GetModuleHandle(NULL), 0);
    if (!g_hHook)
    {
        fprintf(stderr, "Hook failed: %lu\n", GetLastError());
        return 1;
    }

    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0))
    {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    UnhookWindowsHookEx(g_hHook);
    return 0;
}
