const form = document.getElementById('login-form')
const errorEl = document.getElementById('error')
const submit = document.getElementById('submit')

form.addEventListener('submit', async e => {
  e.preventDefault()
  errorEl.textContent = ''
  submit.disabled = true
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'web-torrent' },
      body: JSON.stringify({ username: form.username.value, password: form.password.value })
    })
    if (res.ok) {
      location.href = '/'
      return
    }
    const data = await res.json().catch(() => ({}))
    errorEl.textContent = data.error || 'Ошибка входа'
    form.password.select()
  } catch {
    errorEl.textContent = 'Сервер недоступен'
  } finally {
    submit.disabled = false
  }
})
