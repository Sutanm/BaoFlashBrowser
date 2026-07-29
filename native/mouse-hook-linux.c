#include <X11/Xlib.h>
#include <X11/extensions/record.h>
#include <X11/Xproto.h>
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <sys/select.h>

static Display *dpy = NULL;
static XRecordContext ctx = 0;
static volatile sig_atomic_t running = 1;

static void sig_handler(int sig)
{
    (void)sig;
    running = 0;
}

static void record_callback(XPointer closure, XRecordInterceptData *data)
{
    (void)closure;
    if (data->category != XRecordFromServer) {
        XRecordFreeData(data);
        return;
    }

    xEvent *xev = (xEvent *)data->data;
    if (xev->u.u.type == ButtonPress) {
        int button = xev->u.u.detail;
        int state = xev->u.keyButtonPointer.state;
        if ((button == 4 || button == 5) && (state & ControlMask)) {
            printf(button == 4 ? "ZOOM_IN\n" : "ZOOM_OUT\n");
        }
    }
    XRecordFreeData(data);
}

int main(void)
{
    dpy = XOpenDisplay(NULL);
    if (!dpy) {
        fprintf(stderr, "Cannot open display\n");
        return 1;
    }

    int major_v, minor_v;
    if (!XRecordQueryVersion(dpy, &major_v, &minor_v)) {
        fprintf(stderr, "XRecord extension not available\n");
        XCloseDisplay(dpy);
        return 1;
    }

    XRecordClientSpec clients = XRecordAllClients;
    XRecordRange *range = XRecordAllocRange();
    if (!range) {
        fprintf(stderr, "Cannot allocate range\n");
        XCloseDisplay(dpy);
        return 1;
    }
    range->device_events.first = ButtonPress;
    range->device_events.last  = ButtonPress;

    ctx = XRecordCreateContext(dpy, 0, &clients, 1, &range, 1);
    XFree(range);
    if (!ctx) {
        fprintf(stderr, "Cannot create context\n");
        XCloseDisplay(dpy);
        return 1;
    }

    signal(SIGTERM, sig_handler);
    signal(SIGINT, sig_handler);
    signal(SIGHUP, sig_handler);

    setvbuf(stdout, NULL, _IONBF, 0);

    XRecordEnableContextAsync(dpy, ctx, record_callback, NULL);

    int xfd = ConnectionNumber(dpy);
    while (running) {
        fd_set fds;
        FD_ZERO(&fds);
        FD_SET(xfd, &fds);
        struct timeval tv = { 0, 50000 };
        if (select(xfd + 1, &fds, NULL, NULL, &tv) > 0) {
            XRecordProcessReplies(dpy);
        }
    }

    XRecordDisableContext(dpy, ctx);
    XRecordFreeContext(dpy, ctx);
    XCloseDisplay(dpy);
    return 0;
}
