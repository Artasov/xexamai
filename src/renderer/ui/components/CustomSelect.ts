export type CustomSelectOption = { value: string; label: string; title?: string };

export class CustomSelect {
    private container: HTMLElement;
    private button: HTMLButtonElement;
    private list: HTMLDivElement;
    private options: CustomSelectOption[] = [];
    private value = '';
    private onChange?: (value: string) => void;
    private isOpen = false;

    constructor(container: HTMLElement, options: CustomSelectOption[], initialValue: string, onChange?: (value: string) => void) {
        this.container = container;
        this.onChange = onChange;
        this.button = document.createElement('button');
        this.button.type = 'button';
        this.button.className = 'input-field frbc gap-2 relative w-full';
        this.button.setAttribute('aria-haspopup', 'listbox');
        this.button.setAttribute('aria-expanded', 'false');

        const chevron = document.createElement('span');
        chevron.textContent = '▾';
        chevron.className = 'text-gray-400';

        this.list = document.createElement('div');
        this.list.className = 'rounded shadow-lg';
        this.list.style.background = 'transparent';
        this.list.style.backdropFilter = 'blur(20px)';
        this.list.style.border = '1px solid #fff2';
        this.list.style.boxShadow = '0 8px 32px rgba(0,0,0,.6), 0 0 0 1px rgba(139, 92, 246, 0.1)';
        this.list.setAttribute('role', 'listbox');
        this.list.style.position = 'fixed';
        this.list.style.top = '-1000px';
        this.list.style.left = '-1000px';
        this.list.style.maxHeight = '60vh';
        this.list.style.overflow = 'auto';
        this.list.style.zIndex = '2147483647';
        this.list.style.display = 'none';
        this.list.style.scrollbarWidth = 'thin';
        this.list.style.scrollbarColor = '#8b5cf6 #111111';
        this.list.classList.add('custom-dropdown-scrollbar');

        const wrap = document.createElement('div');
        wrap.className = 'relative w-full';
        wrap.appendChild(this.button);
        this.container.innerHTML = '';
        this.container.appendChild(wrap);
        document.body.appendChild(this.list);

        this.setOptions(options);
        this.setValue(initialValue);

        this.button.addEventListener('click', () => this.toggle());
        document.addEventListener('click', (e) => {
            if (!this.container.contains(e.target as Node)) this.close();
        });
        window.addEventListener('resize', () => this.repositionIfOpen());
        window.addEventListener('scroll', () => this.repositionIfOpen(), true);
    }

    public setOptions(options: CustomSelectOption[]) {
        this.options = options || [];
        this.list.innerHTML = '';
        this.options.forEach((opt) => {
            const item = document.createElement('div');
            item.className = 'px-3 py-2 cursor-pointer transition-colors';
            item.style.color = '#ffffff';
            item.textContent = opt.label;
            if (opt.title) item.title = opt.title;
            item.setAttribute('role', 'option');
            item.dataset.value = opt.value;

            item.addEventListener('mouseenter', () => {
                item.style.background = 'rgba(19,19,19,0.24)';
                item.style.color = '#deceff';
            });
            item.addEventListener('mouseleave', () => {
                item.style.background = 'transparent';
                item.style.color = '#ffffff';
            });
            item.addEventListener('click', () => {
                this.setValue(opt.value);
                this.onChange?.(opt.value);
                this.close();
            });
            this.list.appendChild(item);
        });
        this.updateButtonLabel();
    }

    public setValue(value: string) {
        this.value = value;
        this.updateButtonLabel();
    }

    public getValue(): string {
        return this.value;
    }

    private updateButtonLabel() {
        const current = this.options.find((o) => o.value === this.value) || this.options[0];
        const label = current ? current.label : '';
        this.button.textContent = label || '';
        const chevron = document.createElement('span');
        chevron.textContent = '▾';
        chevron.className = 'ml-2 text-gray-400';
        this.button.appendChild(chevron);
    }

    private toggle() {
        if (this.isOpen) this.close(); else this.open();
    }

    private open() {
        this.reposition();
        this.list.style.display = 'block';
        this.button.setAttribute('aria-expanded', 'true');
        this.isOpen = true;
    }

    private close() {
        this.list.style.display = 'none';
        this.button.setAttribute('aria-expanded', 'false');
        this.isOpen = false;
    }

    private repositionIfOpen() {
        if (!this.isOpen) return;
        this.reposition();
    }

    private reposition() {
        try {
            const rect = this.button.getBoundingClientRect();
            const margin = 4;
            const top = rect.bottom + margin;
            const left = rect.left;
            const width = rect.width;
            this.list.style.top = `${Math.max(0, Math.floor(top))}px`;
            this.list.style.left = `${Math.max(0, Math.floor(left))}px`;
            this.list.style.minWidth = `${Math.max(140, Math.floor(width))}px`;
            this.list.style.maxWidth = `${Math.max(140, Math.floor(Math.min(window.innerWidth - left - 8, 560)))}px`;
        } catch {
        }
    }
}
