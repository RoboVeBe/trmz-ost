# Rebuilds public/index.html from tool/page_src.html + tool/analysis.js
import pathlib
d = pathlib.Path(__file__).parent
src = (d / 'page_src.html').read_text(); ana = (d / 'analysis.js').read_text()
(d.parent / 'public' / 'index.html').write_text(src.replace('//@@ANALYSIS@@', ana))
print('built public/index.html')
