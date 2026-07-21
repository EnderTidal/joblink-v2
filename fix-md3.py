import sys

with open(sys.argv[1], "rb") as f:
    data = f.read()

start = data.find(b"function md(s)")
pos = data.find(b"{", start)
depth = 0
i = pos
while i < len(data):
    if data[i:i+1] == b"{":
        depth += 1
    elif data[i:i+1] == b"}":
        depth -= 1
        if depth == 0:
            end = i + 1
            break
    i += 1

# Build the replacement using raw concatenation to avoid escape issues
# We need: /\*\*(.+?)\*\*/g in the file
bs = b"\x5c"  # backslash
star = b"\x2a"  # asterisk
nl = b"\x5c\x6e"  # literal \n (two chars)

new_func = (
    b"function md(s) {\n"
    b"  if (!s) return '';\n"
    b"  return s\n"
    b"    .replace(/" + bs + star + bs + star + b"(.+?)" + bs + star + bs + star + b"/g, '<strong>$1</strong>')\n"
    b"    .replace(/" + bs + star + b"(.+?)" + bs + star + b"/g, '<em>$1</em>')\n"
    b"    .replace(/`([^`]+)`/g, '<code>$1</code>')\n"
    b"    .replace(/^- (.+)/gm, '<li>$1</li>')\n"
    b"    .replace(/(<li>.*<" + bs + b"/li>)/gs, '<ul>$1</ul>')\n"
    b"    .replace(/" + nl + b"/g, '<br>');\n"
    b"}"
)

data = data[:start] + new_func + data[end:]
with open(sys.argv[1], "wb") as f:
    f.write(data)
print("Fixed md function successfully")
