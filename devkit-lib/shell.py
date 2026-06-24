#!/usr/bin/env python3
"""devkit interactive shell — fully self-contained, zero deps."""

import os
import subprocess
import sys
import termios
import tty
from typing import List, Tuple


DEVKIT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TOOLS: List[Tuple[str, str]] = [
    ("totp",    "TOTP 2FA code manager"),
    ("curl",    "HTTP client (Postman-like)"),
    ("docker",  "Docker container manager"),
    ("cleanup", "Disk space cleanup"),
    ("vpn",     "VPN connection manager"),
]

CYAN = '\033[36m'
BOLD = '\033[1m'
NC = '\033[0m'


def _set_vmin_vtime(fd: int, vmin: int, vtime: int):
    """Set termios VMIN and VTIME for a file descriptor."""
    attrs = termios.tcgetattr(fd)
    attrs[6][termios.VMIN] = vmin
    attrs[6][termios.VTIME] = vtime
    termios.tcsetattr(fd, termios.TCSANOW, attrs)


def read_key(fd: int) -> str:
    """Read a single keypress in raw mode. Returns UP/DOWN/ENTER/ESC or the character."""

    char = sys.stdin.read(1)

    if char == '\x1b':
        # Escape sequence: set 100ms timeout (VTIME=1 decisecond, VMIN=0)
        _set_vmin_vtime(fd, 0, 1)
        seq = sys.stdin.read(2) if sys.stdin.readable() else ''
        # Restore blocking mode
        _set_vmin_vtime(fd, 1, 0)

        if seq in ('[A', 'OA'):
            return 'UP'
        elif seq in ('[B', 'OB'):
            return 'DOWN'
        elif not seq or seq is None:
            return 'ESC'
        return ''

    if char in ('\r', '\n'):
        return 'ENTER'
    if char == '\x7f':
        return 'BACKSPACE'
    return char


def show_suggestions(filter_text: str) -> Tuple[str, int]:
    """Show interactive suggestion popup. Returns (tool_name, index) or ('', -1)."""
    items = [(n, d) for n, d in TOOLS if filter_text in n]
    if not items:
        return '', -1

    selected = 0
    count = len(items)
    lines = count + 2

    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    tty.setraw(fd)

    try:
        sys.stderr.write('\033[?25l')
        sys.stderr.flush()

        while True:
            for i in range(count):
                prefix = ' >' if i == selected else '  '
                line = f'\r  {prefix}  {CYAN}{items[i][0]:<10}{NC}  {items[i][1]:<28}\033[J\n'
                sys.stderr.write(line)

            sys.stderr.write(f'\r  {BOLD}↑↓{NC} nav  {BOLD}Enter{NC} select  {BOLD}Esc{NC} cancel\033[J\n')
            sys.stderr.write(f'\033[{lines}A')
            sys.stderr.flush()

            key = read_key(fd)

            if key == 'UP':
                selected = (selected - 1) % count
            elif key == 'DOWN':
                selected = (selected + 1) % count
            elif key == 'ENTER':
                return items[selected][0], selected
            elif key == 'ESC':
                return '', -1
            elif len(key) == 1 and key.isprintable():
                filter_text += key
                items = [(n, d) for n, d in TOOLS if filter_text in n]
                if not items:
                    return key, -2
                selected = 0
                count = len(items)
                lines = count + 2
    finally:
        sys.stderr.write(f'\033[{lines}B\033[J\033[?25h')
        sys.stderr.flush()
        termios.tcsetattr(fd, termios.TCSADRAIN, old)

    return '', -1


def run_interactive():
    """Main interactive REPL."""
    os.chdir(DEVKIT_DIR)

    print()
    print(f'  {BOLD}╭────────────────────────────────╮{NC}')
    print(f'  {BOLD}│{NC}          {BOLD}devkit{NC} v1.0            {BOLD}│{NC}')
    print(f'  {BOLD}│{NC}     Smart CLI Toolbox           {BOLD}│{NC}')
    print(f'  {BOLD}╰────────────────────────────────╯{NC}')
    print()

    while True:
        try:
            cmd = input('  devkit> ').strip()
        except (EOFError, KeyboardInterrupt):
            print()
            print(f'  {CYAN}Goodbye!{NC}')
            break

        if not cmd:
            print()
            print(f'  {BOLD}Available tools:{NC}')
            for name, desc in TOOLS:
                print(f'  {CYAN}/{name:<10}{NC}  {desc}')
            print(f'  Type {BOLD}/<tool>{NC} or a name. {BOLD}q{NC} to quit.')
            print()
            continue

        if cmd in ('q', 'quit', 'exit', '0'):
            print()
            print(f'  {CYAN}Goodbye!{NC}')
            break

        if cmd.startswith('/'):
            filter_text = cmd[1:].strip()

            # Quick match
            for name, _ in TOOLS:
                if name.startswith(filter_text) and len(filter_text) > 0:
                    run_tool(name)
                    print()
                    break
            else:
                tool_name, _ = show_suggestions(filter_text)
                if tool_name:
                    run_tool(tool_name)
                    print()
            continue

        dispatch = {
            '1': 'totp', '2': 'curl', '3': 'docker', '4': 'cleanup', '5': 'vpn',
            'totp': 'totp', 'curl': 'curl', 'docker': 'docker', 'cleanup': 'cleanup', 'vpn': 'vpn',
        }
        if cmd in dispatch:
            run_tool(dispatch[cmd])
            print()
        else:
            print()
            print(f'  \033[31m[ERR]\033[0m  Unknown: {cmd}')
            print()


def run_tool(name: str):
    """Launch a devkit tool in a subprocess."""
    devkit = os.path.join(DEVKIT_DIR, 'devkit')
    print()
    subprocess.run([devkit, name])


def main():
    run_interactive()


if __name__ == '__main__':
    main()
