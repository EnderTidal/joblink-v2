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

new_func = b"function md(s) {\n  if (!s) return '';\n  return s\n    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')\n    .replace(/\*(.+?)\*/g, '<em>$1</em>')\n    .replace(/`([^`]+)`/g, '<code>$1</code>')\n    .replace(/^- (.+)/gm, '<li>$1</li>')\n    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')\n    .replace(/\n/g, '<br>');\n}"

data = data[:start] + new_func + data[end:]
with open(sys.argv[1], "wb") as f:
    f.write(data)
print("Fixed")
