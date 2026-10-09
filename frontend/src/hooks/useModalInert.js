import { useEffect, useRef } from 'react';

/**
 * Hook to deactivate all interactive elements in the background when any modal is open,
 * preventing PS5 controller spatial navigation from snapping to buttons underneath.
 *
 * @param {boolean} isModalOpen - True if any modal dialog is currently open
 */
export function useModalInert(isModalOpen) {
  const previousFocusRef = useRef(null);

  useEffect(() => {
    if (!isModalOpen) {
      // Native inert can blur the opener during React's commit, before the
      // open effect runs. Remember focus while the background is still active.
      const rememberFocus = (event) => {
        if (event.target !== document.body && event.target !== document.documentElement) previousFocusRef.current = event.target;
      };
      if (document.activeElement && document.activeElement !== document.body) previousFocusRef.current = document.activeElement;
      window.addEventListener('focusin', rememberFocus, true);
      return () => window.removeEventListener('focusin', rememberFocus, true);
    }

    // 1. Remember previously focused element to restore when modal closes
    if (document.activeElement && document.activeElement !== document.body) {
      previousFocusRef.current = document.activeElement;
    }

    const background = document.getElementById('app-main-content');

    const deactivateElement = (el) => {
      if (!el) return;

      if (!el.hasAttribute('data-modal-prev-disabled')) {
        const wasDisabled = el.disabled === true || el.hasAttribute('disabled');
        el.setAttribute('data-modal-prev-disabled', wasDisabled ? 'true' : 'false');

        const prevTabIndex = el.getAttribute('tabindex');
        el.setAttribute('data-modal-prev-tabindex', prevTabIndex !== null ? prevTabIndex : '__none__');
      }

      if ('disabled' in el && !el.disabled) {
        el.disabled = true;
      }
      if (el.getAttribute('tabindex') !== '-1') el.setAttribute('tabindex', '-1');
    };

    const deactivateBackground = () => {
      if (!background) return;

      try {
        background.setAttribute('inert', '');
        background.setAttribute('aria-hidden', 'true');
      } catch (e) {}

      const focusableSelector = 'button, a[href], input, select, textarea, [tabindex]';
      const elements = background.querySelectorAll(focusableSelector);
      elements.forEach(deactivateElement);
    };

    deactivateBackground();

    // 2. Watch for background re-renders while modal is open
    let observer = null;
    if (background && window.MutationObserver) {
      observer = new MutationObserver((records) => {
        // Remember React's latest intended states, then reapply the workaround.
        // This matters on PS5 browsers without native inert support when a
        // background install finishes and React enables a button again.
        records.forEach(({ type, target, attributeName }) => {
          if (type !== 'attributes' || !target.hasAttribute('data-modal-prev-disabled')) return;
          if (attributeName === 'disabled') target.setAttribute('data-modal-prev-disabled', target.disabled ? 'true' : 'false');
          if (attributeName === 'tabindex') target.setAttribute('data-modal-prev-tabindex', target.getAttribute('tabindex') ?? '__none__');
        });
        deactivateBackground();
        observer.takeRecords(); // Discard the attribute changes made by this hook.
      });
      observer.observe(background, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'tabindex'] });
    }

    // 3. Move controller focus to the primary/cancel button inside the modal
    const focusTimer = setTimeout(() => {
      const modalDialog = document.querySelector('[data-modal-dialog="true"]') ||
                          document.querySelector('[role="dialog"]');
      if (modalDialog) {
        const focusables = Array.from(modalDialog.querySelectorAll(
          'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
        ));

        let target = focusables.find((el) =>
          /cancel|close|maybe later|don't show/i.test(el.textContent || el.getAttribute('aria-label') || '')
        ) || focusables[0];

        if (target && typeof target.focus === 'function') {
          target.focus();
        }
      }
    }, 40);

    // 4. Trap Tab navigation within the modal
    const handleKeyDown = (e) => {
      if (e.key === 'Tab') {
        const modalDialog = document.querySelector('[data-modal-dialog="true"]') ||
                            document.querySelector('[role="dialog"]');
        if (!modalDialog) return;

        const focusables = Array.from(modalDialog.querySelectorAll(
          'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
        ));

        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first || !modalDialog.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last || !modalDialog.contains(document.activeElement)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    const handleFocusIn = (event) => {
      const modalDialog = document.querySelector('[data-modal-dialog="true"]') || document.querySelector('[role="dialog"]');
      if (!modalDialog || modalDialog.contains(event.target)) return;
      // Redirect after the current focus event to avoid nested focus changes.
      Promise.resolve().then(() => {
        if (!document.contains(modalDialog) || modalDialog.contains(document.activeElement)) return;
        const target = modalDialog.querySelector('button:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])');
        target?.focus();
      });
    };
    window.addEventListener('focusin', handleFocusIn, true);

    // 5. Cleanup on modal close: restore background states & focus
    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('focusin', handleFocusIn, true);

      if (observer) {
        observer.disconnect();
      }

      if (background) {
        try {
          background.removeAttribute('inert');
          background.removeAttribute('aria-hidden');
        } catch (e) {}

        const modified = background.querySelectorAll('[data-modal-prev-disabled]');
        modified.forEach((el) => {
          const wasDisabled = el.getAttribute('data-modal-prev-disabled') === 'true';
          if ('disabled' in el) {
            el.disabled = wasDisabled;
          }
          if (wasDisabled) {
            el.setAttribute('disabled', '');
          } else {
            el.removeAttribute('disabled');
          }

          const prevTab = el.getAttribute('data-modal-prev-tabindex');
          if (prevTab && prevTab !== '__none__') {
            el.setAttribute('tabindex', prevTab);
          } else {
            el.removeAttribute('tabindex');
          }

          el.removeAttribute('data-modal-prev-disabled');
          el.removeAttribute('data-modal-prev-tabindex');
        });
      }

      // Restore focus to previous element if it is still in the document
      if (previousFocusRef.current && document.contains(previousFocusRef.current)) {
        try {
          previousFocusRef.current.focus();
        } catch (e) {}
      }
    };
  }, [isModalOpen]);
}
