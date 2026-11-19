from PIL import Image, ImageDraw, ImageFont
import io, sys
F='/usr/share/fonts/opentype/inter/Inter-Bold.otf'
def make(s):
    S=s*4; im=Image.new('RGBA',(S,S),(0,0,0,0)); d=ImageDraw.Draw(im)
    m=int(S*0.04); d.rounded_rectangle([m,m,S-m,S-m], radius=int(S*0.22), fill=(216,67,59,255))
    # page shape
    pw,ph=S*0.50,S*0.62; x0=(S-pw)/2; y0=(S-ph)/2; f=S*0.14
    d.polygon([(x0,y0),(x0+pw-f,y0),(x0+pw,y0+f),(x0+pw,y0+ph),(x0,y0+ph)], fill=(255,255,255,255))
    d.polygon([(x0+pw-f,y0),(x0+pw-f,y0+f),(x0+pw,y0+f)], fill=(246,190,186,255))
    font=ImageFont.truetype(F, int(S*0.36))
    d.text((S/2, y0+ph*0.58), 'A', font=font, fill=(216,67,59,255), anchor='mm')
    return im.resize((s,s), Image.LANCZOS)
out={}
for s in (16,24,32,48,64,128,256):
    b=io.BytesIO(); make(s).save(b,'PNG'); open(f'tools/icon{s}.png','wb').write(b.getvalue())
make(256).save('tools/icon_preview.png')
