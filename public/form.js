(function () {
  'use strict';

  let SCHEMA = null;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, cls) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };

  // Charge le schéma puis construit le formulaire
  fetch('/api/questions')
    .then((r) => r.json())
    .then((schema) => {
      SCHEMA = schema;
      $('#form-title').textContent = schema.title;
      $('#form-subtitle').textContent = schema.subtitle;
      document.title = schema.title;
      buildForm(schema);
    })
    .catch(() => {
      $('#form-title').textContent = 'Erreur de chargement';
      $('#form-subtitle').textContent = 'Impossible de charger le formulaire. Réessaie.';
    });

  function buildForm(schema) {
    const container = $('#sections');
    const sectionsMap = {};

    schema.questions.forEach((q) => {
      const sec = q.section;
      if (!sectionsMap[sec]) {
        const block = el('div', 'section');
        block.dataset.section = sec;
        const head = el('div', 'section-head');
        const num = el('div', 'section-num');
        num.textContent = sec;
        const title = el('div', 'section-title');
        title.textContent = schema.sections[sec] || '';
        head.appendChild(num);
        head.appendChild(title);
        block.appendChild(head);
        container.appendChild(block);
        sectionsMap[sec] = block;
      }
      sectionsMap[sec].appendChild(renderQuestion(q));
    });

    // Gestion des questions conditionnelles (showIf)
    applyConditionals();
    container.addEventListener('change', () => {
      applyConditionals();
      updateProgress();
    });
    container.addEventListener('input', updateProgress);

    $('#surveyForm').addEventListener('submit', onSubmit);
    updateProgress();
  }

  function renderQuestion(q) {
    const wrap = el('div', 'q');
    wrap.dataset.qid = q.id;
    if (q.showIf) wrap.dataset.showif = JSON.stringify(q.showIf);

    const label = el('div', 'q-label');
    label.innerHTML =
      escapeHtml(q.label) + (q.required ? ' <span class="req">*</span>' : '');
    wrap.appendChild(label);

    if (q.help) {
      const help = el('div', 'q-help');
      help.textContent = q.help;
      wrap.appendChild(help);
    }

    if (q.type === 'text') {
      const input = el('input', 'txt');
      input.type = 'text';
      input.name = q.id;
      wrap.appendChild(input);
    } else if (q.type === 'textarea') {
      const area = el('textarea', 'area');
      area.name = q.id;
      wrap.appendChild(area);
    } else if (q.type === 'single' || q.type === 'multi') {
      const opts = el('div', 'opts');
      const inputType = q.type === 'single' ? 'radio' : 'checkbox';
      const allOptions = q.options.slice();
      if (q.other) allOptions.push('__OTHER__');

      allOptions.forEach((optText) => {
        const isOther = optText === '__OTHER__';
        const optLabel = el('label', 'opt');
        const input = el('input');
        input.type = inputType;
        input.name = q.id;
        input.value = isOther ? 'Autre' : optText;
        if (isOther) input.dataset.other = '1';

        const span = el('span');
        span.textContent = isOther ? 'Autre…' : optText;

        optLabel.appendChild(input);
        optLabel.appendChild(span);
        opts.appendChild(optLabel);

        input.addEventListener('change', () => {
          // état visuel
          if (inputType === 'radio') {
            opts.querySelectorAll('.opt').forEach((o) => o.classList.remove('checked'));
          }
          optLabel.classList.toggle('checked', input.checked);
          if (q.maxSelect) enforceMax(opts, q.maxSelect, wrap);
        });

        if (isOther) {
          const otherWrap = el('div', 'opt-other-input');
          const otherInput = el('input', 'txt');
          otherInput.type = 'text';
          otherInput.placeholder = 'Précise…';
          otherInput.dataset.otherFor = q.id;
          otherWrap.appendChild(otherInput);
          opts.appendChild(otherWrap);
          input.addEventListener('change', () => {
            otherWrap.classList.toggle('show', input.checked);
            if (input.checked) otherInput.focus();
          });
        }
      });

      wrap.appendChild(opts);

      if (q.maxSelect) {
        const hint = el('div', 'maxhint');
        hint.dataset.maxhint = '1';
        hint.textContent = '0 / ' + q.maxSelect + ' sélectionnés';
        wrap.appendChild(hint);
      }
    }

    return wrap;
  }

  function enforceMax(opts, max, wrap) {
    const checked = opts.querySelectorAll('input[type=checkbox]:checked');
    const hint = wrap.querySelector('[data-maxhint]');
    if (hint) {
      hint.textContent = checked.length + ' / ' + max + ' sélectionnés';
      hint.classList.toggle('reached', checked.length >= max);
    }
    const disable = checked.length >= max;
    opts.querySelectorAll('input[type=checkbox]').forEach((c) => {
      if (!c.checked) c.disabled = disable;
    });
  }

  function applyConditionals() {
    document.querySelectorAll('.q[data-showif]').forEach((q) => {
      const cond = JSON.parse(q.dataset.showif);
      const controlling = document.querySelector(
        'input[name="' + cond.q + '"]:checked'
      );
      const visible = controlling && controlling.value === cond.value;
      q.style.display = visible ? '' : 'none';
    });
  }

  function collectAnswers() {
    const answers = {};
    SCHEMA.questions.forEach((q) => {
      const qEl = document.querySelector('.q[data-qid="' + q.id + '"]');
      if (qEl && qEl.style.display === 'none') return; // question cachée

      if (q.type === 'text' || q.type === 'textarea') {
        const input = document.querySelector('[name="' + q.id + '"]');
        const val = input ? input.value.trim() : '';
        if (val) answers[q.id] = val;
      } else if (q.type === 'single') {
        const sel = document.querySelector('input[name="' + q.id + '"]:checked');
        if (sel) {
          answers[q.id] = sel.value;
          if (sel.dataset.other) {
            const ot = document.querySelector('[data-other-for="' + q.id + '"]');
            if (ot && ot.value.trim()) answers[q.id + '_other'] = ot.value.trim();
          }
        }
      } else if (q.type === 'multi') {
        const sels = document.querySelectorAll('input[name="' + q.id + '"]:checked');
        const vals = Array.from(sels).map((s) => s.value);
        if (vals.length) {
          answers[q.id] = vals;
          const otherSel = Array.from(sels).find((s) => s.dataset.other);
          if (otherSel) {
            const ot = document.querySelector('[data-other-for="' + q.id + '"]');
            if (ot && ot.value.trim()) answers[q.id + '_other'] = ot.value.trim();
          }
        }
      }
    });
    return answers;
  }

  function updateProgress() {
    const total = SCHEMA.questions.filter((q) => {
      const qEl = document.querySelector('.q[data-qid="' + q.id + '"]');
      return qEl && qEl.style.display !== 'none';
    }).length;
    const answers = collectAnswers();
    const done = Object.keys(answers).filter((k) => !k.endsWith('_other')).length;
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    $('#progressBar').style.width = pct + '%';
  }

  function onSubmit(e) {
    e.preventDefault();
    const errBox = $('#formError');
    errBox.hidden = true;
    document.querySelectorAll('.q.invalid').forEach((q) => q.classList.remove('invalid'));

    const answers = collectAnswers();

    // Validation client des questions obligatoires
    const missing = SCHEMA.questions.filter((q) => {
      if (!q.required) return false;
      const qEl = document.querySelector('.q[data-qid="' + q.id + '"]');
      if (qEl && qEl.style.display === 'none') return false;
      const v = answers[q.id];
      return v === undefined || v === null || (Array.isArray(v) && !v.length) || v === '';
    });

    if (missing.length) {
      missing.forEach((q) => {
        const qEl = document.querySelector('.q[data-qid="' + q.id + '"]');
        if (qEl) qEl.classList.add('invalid');
      });
      errBox.textContent =
        'Merci de répondre aux questions obligatoires (marquées d\'une *).';
      errBox.hidden = false;
      missing[0] &&
        document
          .querySelector('.q[data-qid="' + missing[0].id + '"]')
          .scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = 'Envoi…';

    fetch('/api/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d.error || 'Erreur');
        $('#surveyForm').hidden = true;
        document.querySelector('.hero').hidden = true;
        $('#successScreen').hidden = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      })
      .catch((err) => {
        errBox.textContent = err.message || 'Une erreur est survenue. Réessaie.';
        errBox.hidden = false;
        btn.disabled = false;
        btn.textContent = 'Envoyer mes réponses 🚀';
      });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
})();
