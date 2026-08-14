# Ruffle button1 fixture

`ruffle-button1.swf.base64` is the base64 representation of:

```text
https://github.com/ruffle-rs/ruffle/blob/master/tests/tests/swfs/from_shumway/button1/test.swf
```

Upstream size: 1031 bytes. The upstream project is dual licensed under MIT or
Apache-2.0. Its prescribed input sequence targets SWF stage position 250,200.
The upstream visual regression test captures separate normal, hover, pressed,
and released frames, making it suitable for proving minimized input delivery.

The fixture is stored as text so its source and exact bytes remain reviewable.
The Electron smoke decodes it only into the ignored `release/automation-probe`
directory when PPAPI requires a file URL.
