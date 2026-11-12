const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dots=n=>String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g,'.'),vnd=n=>dots(n)+'đ',dmy=d=>d.split('-').reverse().join('/'),num=v=>parseInt(String(v).replace(/\D/g,''))||0;
const shortHash=h=>h?h.slice(0,8)+'…'+h.slice(-6):'';
const money=i=>{const n=num(i.value);i.value=n?dots(n):''};
async function api(u,b){const r=await fetch('/api/'+u,b===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const d=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(d.e||'Có lỗi xảy ra'),{st:r.status});return d}
function toast(t,bad){const e=document.createElement('div');e.id='toast';e.className=bad?'bad':'';e.textContent=t;document.body.append(e);setTimeout(()=>e.remove(),3600)}
function openModal(h){$('#m').innerHTML='<div class="mb">'+h+'</div>';$('#m').hidden=false}
function closeModal(){$('#m').hidden=true;$('#m').innerHTML='';clearInterval(window.tm)}
function txHtml(txHash,url){
  if(!txHash)return '<span class=note>Off-chain</span>';
  const s=esc(shortHash(txHash));
  return url?`<a href="${esc(url)}" target=_blank rel=noopener class=mono title="${esc(txHash)}">${s} ↗</a>`:`<span class="badge nft mono" title="${esc(txHash)}">${s}</span>`;
}
function showChainInfo(){
  const me=window.me||{};const c=me.chain||{};
  const link=(addr,url)=>addr?(url?`<a href="${esc(url)}" target=_blank rel=noopener class=mono>${esc(addr)} ↗</a>`:`<span class=mono>${esc(addr)}</span>`):'<i>Chưa deploy</i>';
  openModal(`<h2>Trạng thái Smart Contract</h2>
    <table class=info>
      <tr><th>Mạng</th><td><b>${esc(c.networkName||'Off-chain')}</b>${c.chainId?` (Chain ID: ${c.chainId})`:''}</td></tr>
      <tr><th>Trạng thái</th><td>${c.enabled?'<span class="badge nft">Đã kết nối On-chain</span>':'<span class="badge out">Off-chain fallback</span>'}</td></tr>
      <tr><th>Ví của bạn</th><td class=mono>${esc(me.wallet||'—')}</td></tr>
      <tr><th>AvaTicket NFT</th><td>${link(c.avaTicketAddress,c.avaTicketExplorer)}</td></tr>
      <tr><th>Marketplace</th><td>${link(c.marketplaceAddress,c.marketplaceExplorer)}</td></tr>
      <tr><th>Relayer (Gasless)</th><td class=mono>${esc(c.relayerAddress||'—')}</td></tr>
    </table>
    <p class=note>Mô hình Relayer: mọi giao dịch mua vé, bán lại và check-in được ghi nhận lên smart contract mà bạn không cần trả phí gas.</p>
    <div class=row><button class="btn ghost" onclick=closeModal()>Đóng</button></div>`);
}
function renderHistory(rows){
  const labels={topup:'Nạp tiền',buy:'Mua vé',sale:'Bán vé',list:'Đăng bán lại',scan:'Soát vé',verify_email:'Xác thực Email',security:'Bảo mật / Mật khẩu'};
  if(!rows.length)return '<div class="card empty">Chưa có giao dịch nào.</div>';
  return `<div class="card tbl-wrap"><table class=hist>
    <thead><tr><th>Thời gian</th><th>Loại</th><th>Số tiền</th><th>Chi tiết</th><th>Minh chứng On-chain</th></tr></thead>
    <tbody>${rows.map(tx=>`<tr>
      <td>${esc(tx.at)}</td>
      <td><span class=badge>${esc(labels[tx.type]||tx.type)}</span></td>
      <td><b>${tx.amount>0?'+'+vnd(tx.amount):tx.amount<0?'-'+vnd(Math.abs(tx.amount)):'—'}</b></td>
      <td>${esc(tx.note)}</td>
      <td>${txHtml(tx.tx_hash,tx.explorerUrl)}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}
function renderTop(me,role){
  const c=me.chain||{};
  const pill=c.enabled?`⛓️ ${esc(c.networkName)}`:'⛓️ Off-chain';
  const secBtn=me.emailVerified
    ?`<button class="chain-pill on" onclick=openSecurityModal() title="Email đã xác thực · Đổi mật khẩu">✓ Email · Đổi MK</button>`
    :`<button class="chain-pill warn" onclick=openSecurityModal() title="Xác thực email & Đổi mật khẩu">⚠️ Xác thực Email</button>`;
  $('#top').innerHTML=`<div class=logo><span>AVA</span>-TIX</div>
    <button class="chain-pill ${c.enabled?'on':'off'}" onclick=showChainInfo() title="Xem thông tin Smart Contract">${pill}</button>
    ${secBtn}
    <span>${role==='customer'?'Khách hàng':'Nhà cung cấp'}: <b>${esc(me.username)}</b></span>
    <span class=bal>Ví: <span id=bal></span></span>
    <button class="btn sm" onclick=topup()>Nạp tiền</button>
    <button class="btn sm ghost" onclick=logout()>Đăng xuất</button>`;
  setBal(me);
}
function openSecurityModal(){
  const me=window.me||{};
  const role=me.role;
  openModal(`<h2>Tài khoản &amp; Bảo mật</h2>
    <table class=info>
      <tr><th>Tên đăng nhập</th><td><b>${esc(me.username)}</b></td></tr>
      <tr><th>Email</th><td>${esc(me.email)} ${me.emailVerified?'<span class="badge nft">Đã xác thực</span>':'<span class="badge out">Chưa xác thực</span>'}</td></tr>
    </table>
    ${me.emailVerified?'':`
      <div class=sec-box>
        <h3>1. Xác thực Email</h3>
        <p class=note>Cần xác thực email trước khi đổi mật khẩu hoặc khôi phục tài khoản.</p>
        <div id=evBox></div>
        <div class=row>
          <button class="btn sm" id=evSend>Gửi mã OTP</button>
          <input id=evCode inputmode=numeric maxlength=6 placeholder="Nhập OTP 6 số" style="flex:1">
          <button class="btn sm" id=evOk>Xác nhận</button>
        </div>
      </div>`}
    <div class=sec-box>
      <h3>${me.emailVerified?'Đổi mật khẩu':'2. Đổi mật khẩu'}</h3>
      ${me.emailVerified?`
        <p class=note>Bắt buộc xác thực cả <b>Mật khẩu hiện tại</b> và <b>Mã OTP gửi về Email</b>.</p>
        <label>Mật khẩu hiện tại</label><input id=cpOld type=password autocomplete=current-password>
        <div id=cpBox></div>
        <div class=row style="margin-top:10px">
          <button class="btn sm ghost" id=cpSend>Gửi OTP xác nhận</button>
          <input id=cpCode inputmode=numeric maxlength=6 placeholder="Mã OTP 6 số" style="flex:1">
        </div>
        <label>Mật khẩu mới (≥ 8 ký tự, 1 chữ hoa, 1 số)</label><input id=cpNew type=password autocomplete=new-password>
        <label>Xác nhận mật khẩu mới</label><input id=cpNew2 type=password autocomplete=new-password>
        <div class=row><button class="btn ghost" onclick=closeModal()>Đóng</button><button class=btn id=cpOk>Đổi mật khẩu</button></div>
      `:`
        <p class=note err>🔒 Vui lòng xác thực Email ở trên trước khi đổi mật khẩu.</p>
        <div class=row><button class="btn ghost" onclick=closeModal()>Đóng</button></div>
      `}
    </div>`);

  if(!me.emailVerified){
    $('#evSend').onclick=async()=>{
      try{
        const r=await api('verify-email/request',{});
        $('#evBox').innerHTML=r.devOtp?`<div class=dev-otp><b>[Dev Mode]</b> Mã OTP mẫu: <b class=mono>${esc(r.devOtp)}</b> (hiệu lực 5 phút)</div>`:`<p class="note good">Đã gửi OTP tới ${esc(r.maskedEmail)}</p>`;
        toast('Đã gửi mã OTP xác thực email');
      }catch(e){toast(e.message,1)}
    };
    $('#evOk').onclick=async()=>{
      try{
        await api('verify-email/confirm',{code:$('#evCode').value.trim()});
        toast('Xác thực Email thành công!');
        window.me=await api('me');
        renderTop(window.me,role);
        if(typeof load==='function')load();
        openSecurityModal();
      }catch(e){toast(e.message,1)}
    };
  }else{
    $('#cpSend').onclick=async()=>{
      try{
        const r=await api('change-password/request',{currentPassword:$('#cpOld').value});
        $('#cpBox').innerHTML=r.devOtp?`<div class=dev-otp><b>[Dev Mode]</b> Mã OTP đổi MK: <b class=mono>${esc(r.devOtp)}</b></div>`:`<p class="note good">Đã gửi OTP tới ${esc(r.maskedEmail)}</p>`;
        toast('Đã gửi OTP xác nhận đổi mật khẩu');
      }catch(e){toast(e.message,1)}
    };
    $('#cpOk').onclick=async()=>{
      const np=$('#cpNew').value,np2=$('#cpNew2').value;
      if(np!==np2)return toast('Mật khẩu xác nhận không khớp',1);
      try{
        await api('change-password/confirm',{currentPassword:$('#cpOld').value,newPassword:np,code:$('#cpCode').value.trim()});
        closeModal();
        toast('Đổi mật khẩu thành công!');
        if(typeof load==='function')load();
      }catch(e){toast(e.message,1)}
    };
  }
}
async function init(role){
  document.body.insertAdjacentHTML('beforeend','<div id=m hidden></div>');
  $('#m').onclick=e=>{if(e.target.id==='m')closeModal()};
  try{
    const me=await api('me');
    if(me.role!==role){location='/'+me.role+'.html';return}
    renderTop(me,role);return me;
  }catch{location='/login.html'}
}
const setBal=m=>$('#bal').textContent=vnd(m.balance);
async function logout(){await api('logout',{});location='/login.html'}
function topup(){
  openModal(`<h2>Nạp tiền vào ví</h2><label>Số tiền (VNĐ)</label><input id=amt inputmode=numeric placeholder="Ví dụ: 500.000" oninput=money(this)><p class=note>Tối thiểu 10.000đ. Dấu chấm tự động phân tách hàng nghìn.</p>
  <label>Phương thức thanh toán</label><div class=pay>${[['momo','Ví MoMo'],['bank','Ngân hàng'],['vnpay','VNPAY'],['vietqr','VietQR']].map(([v,t],i)=>`<label class=r><input type=radio name=pm value=${v} ${i?'':'checked'}>${t}</label>`).join('')}</div>
  <div class=row><button class="btn ghost" onclick=closeModal()>Hủy</button><button class=btn id=go>Nạp tiền</button></div>`);
  $('#go').onclick=async()=>{try{await api('topup',{amount:num($('#amt').value),method:document.querySelector('[name=pm]:checked').value});closeModal();toast('Nạp tiền thành công');window.me=await api('me');setBal(window.me)}catch(e){toast(e.message,1)}};
}
