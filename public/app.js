const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dots=n=>String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g,'.'),vnd=n=>dots(n)+'đ',dmy=d=>d.split('-').reverse().join('/'),num=v=>parseInt(String(v).replace(/\D/g,''))||0;
const money=i=>{const n=num(i.value);i.value=n?dots(n):''};
async function api(u,b){const r=await fetch('/api/'+u,b===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const d=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(d.e||'Có lỗi xảy ra'),{st:r.status});return d}
function toast(t,bad){const e=document.createElement('div');e.id='toast';e.className=bad?'bad':'';e.textContent=t;document.body.append(e);setTimeout(()=>e.remove(),3200)}
function openModal(h){$('#m').innerHTML='<div class="mb">'+h+'</div>';$('#m').hidden=false}
function closeModal(){$('#m').hidden=true;$('#m').innerHTML='';clearInterval(window.tm)}
async function init(role){document.body.insertAdjacentHTML('beforeend','<div id=m hidden></div>');   $('#m').onclick=e=>{if(e.target.id==='m')closeModal()};
 try{const me=await api('me');if(me.role!==role){location='/'+me.role+'.html';return}
 $('#top').innerHTML=`<div class=logo><span>AVA</span>-TIX</div><span>${role==='customer'?'Khách hàng':'Nhà cung cấp'}: <b>${esc(me.username)}</b></span><span class=bal>Ví: <span id=bal></span></span><button class="btn sm" onclick=topup()>Nạp tiền</button><button class="btn sm ghost" onclick=logout()>Đăng xuất</button>`;setBal(me);return me}
 catch{location='/login.html'}}
const setBal=m=>$('#bal').textContent=vnd(m.balance);
async function logout(){await api('logout',{});location='/login.html'}
function topup(){openModal(`<h2>Nạp tiền vào ví</h2><label>Số tiền (VNĐ)</label><input id=amt inputmode=numeric placeholder="Ví dụ: 500.000" oninput=money(this)><p class=note>Tối thiểu 10.000đ. Dấu chấm tự động phân tách hàng nghìn.</p>
<label>Phương thức thanh toán</label><div class=pay>${[['momo','Ví MoMo'],['bank','Ngân hàng'],['vnpay','VNPAY'],['vietqr','VietQR']].map(([v,t],i)=>`<label class=r><input type=radio name=pm value=${v} ${i?'':'checked'}>${t}</label>`).join('')}</div>
<div class=row><button class="btn ghost" onclick=closeModal()>Hủy</button><button class=btn id=go>Nạp tiền</button></div>`);
 $('#go').onclick=async()=>{try{await api('topup',{amount:num($('#amt').value),method:document.querySelector('[name=pm]:checked').value});closeModal();toast('Nạp tiền thành công');window.me=await api('me');setBal(window.me)}catch(e){toast(e.message,1)}}}
