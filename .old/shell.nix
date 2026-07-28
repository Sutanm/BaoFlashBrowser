{ pkgs ? import <nixpkgs> {} }:

(pkgs.buildFHSEnv {
  name = "baoflash-fhs";
  targetPkgs = pkgs: with pkgs; [
    nodejs_22
    bash
    coreutils
    which
    git

    glib
    gtk3
    nss
    nspr
    alsa-lib
    cups
    libdrm
    libxkbcommon
    libpulseaudio
    mesa
    libglvnd
    libgbm
    pango
    atk
    cairo
    gdk-pixbuf
    dbus
    expat
    libxcb
    fontconfig
    freetype
    libuuid

    xorg.libX11
    xorg.libXcomposite
    xorg.libXdamage
    xorg.libXext
    xorg.libXfixes
    xorg.libXrandr
    xorg.libXrender
    xorg.libXi
    xorg.libXScrnSaver
    xorg.libXtst
    xorg.libxcb
    xorg.libxshmfence

    libnotify
    at-spi2-core
    libsecret

    gcc
    gnumake
    pkg-config
    vips
    python3
  ];
  runScript = "bash";
  profile = ''
    unset ELECTRON_RUN_AS_NODE
    unset ELECTRON_NO_ATTACH_CONSOLE
    export GLIBC_TUNABLES=glibc.pthread.use_clone3=0:glibc.cpu.hwcaps=-SHSTK,-IBT
  '';
})
