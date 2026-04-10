document.addEventListener('DOMContentLoaded', () => {
  // ── 1. SKELETON LOADER ──
  const skeleton = document.getElementById('skeleton-container');
  const appContent = document.getElementById('app-content');

  setTimeout(() => {
    skeleton.style.opacity = '0';
    appContent.style.opacity = '1';

    setTimeout(() => {
      skeleton.style.display = 'none';
      observer.disconnect();
      document.querySelectorAll('.animate-on-scroll').forEach(el => {
        observer.observe(el);
      });
    }, 600);
  }, 800);

  // ── 2. SCROLL ANIMATIONS ──
  const observerOptions = {
    root: null,
    rootMargin: '0px',
    threshold: 0.1
  };

  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        obs.unobserve(entry.target);
      }
    });
  }, observerOptions);

  document.querySelectorAll('.animate-on-scroll').forEach(el => {
    observer.observe(el);
  });

  // ── 3. MOBILE MENU ──
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  const sidebar = document.getElementById('sidebar');

  mobileMenuBtn.addEventListener('click', () => {
    sidebar.classList.toggle('open');
  });

  // Close sidebar when a link is clicked on mobile
  sidebar.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        sidebar.classList.remove('open');
      }
    });
  });

  // ── 4. ACTIVE LINK HIGHLIGHTING ──
  const sections = document.querySelectorAll('main section');
  const navLinks = document.querySelectorAll('.sidebar-nav a');

  window.addEventListener('scroll', () => {
    let current = '';
    sections.forEach(section => {
      const sectionTop = section.offsetTop;
      const sectionHeight = section.clientHeight;
      if (pageYOffset >= (sectionTop - 200)) {
        current = section.getAttribute('id');
      }
    });

    navLinks.forEach(link => {
      link.classList.remove('active');
      if (link.getAttribute('href').includes(current)) {
        link.classList.add('active');
      }
    });
  });

  // ── 5. LANGUAGE TOGGLE ──
  let currentLang = localStorage.getItem('obl-doc-lang') || 'en';
  const langBtns = document.querySelectorAll('.lang-btn');

  function applyLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('obl-doc-lang', lang);

    // Update buttons
    langBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.lang === lang);
    });

    // Update all elements with data-en / data-id attributes
    document.querySelectorAll('[data-en][data-id]').forEach(el => {
      const text = el.getAttribute(`data-${lang}`);
      if (text) {
        // Check if the element contains only text (no child elements with their own data attributes)
        const childTranslatables = el.querySelectorAll('[data-en][data-id]');
        if (childTranslatables.length === 0) {
          el.innerHTML = text;
        }
      }
    });

    // Update html lang attribute
    document.documentElement.lang = lang === 'id' ? 'id' : 'en';
  }

  langBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      applyLanguage(btn.dataset.lang);
    });
  });

  // Apply saved language on load
  applyLanguage(currentLang);
});
