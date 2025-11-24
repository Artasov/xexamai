import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import './CustomSelect.scss';

type ClassValue = string | undefined | null | false | Record<string, boolean>;
function classNames(...values: ClassValue[]): string {
    const tokens: string[] = [];
    for (const value of values) {
        if (!value) continue;
        if (typeof value === 'string') {
            tokens.push(value);
        } else {
            for (const [key, active] of Object.entries(value)) {
                if (active) tokens.push(key);
            }
        }
    }
    return tokens.join(' ');
}

export type CustomSelectOption = {
    value: string;
    label: string;
    description?: string;
    disabled?: boolean;
};

type CustomSelectProps = {
    value: string | null | undefined;
    options: CustomSelectOption[];
    placeholder?: string;
    disabled?: boolean;
    onChange: (value: string) => void;
    className?: string;
};

export const CustomSelect = ({
    value,
    options,
    placeholder = 'Select',
    disabled = false,
    onChange,
    className,
}: CustomSelectProps) => {
    const [open, setOpen] = useState(false);
    const [renderDropdown, setRenderDropdown] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const dropdownRef = useRef<HTMLUListElement>(null);
    const [dropdownStyle, setDropdownStyle] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);

    const selected = useMemo(
        () => options.find((option) => option.value === value) ?? null,
        [options, value],
    );

    const updatePosition = useCallback(() => {
        if (!buttonRef.current) return;

        const rect = buttonRef.current.getBoundingClientRect();
        const dropdownHeight = dropdownRef.current?.offsetHeight ?? 0;
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        const viewportPadding = 16;
        const boundaryElement = containerRef.current?.closest<HTMLElement>('.holder-card, .settings-card, .card');
        const boundaryRect = boundaryElement?.getBoundingClientRect();

        const boundaryLeft = boundaryRect ? boundaryRect.left + window.scrollX + 8 : window.scrollX + viewportPadding;
        const boundaryRight = boundaryRect ? boundaryRect.right + window.scrollX - 8 : window.scrollX + viewportWidth - viewportPadding;
        const boundaryTop = boundaryRect ? boundaryRect.top + window.scrollY + 8 : window.scrollY + viewportPadding;
        const boundaryBottom = boundaryRect ? boundaryRect.bottom + window.scrollY - 8 : window.scrollY + viewportHeight - viewportPadding;
        const availableWidth = Math.max(40, boundaryRight - boundaryLeft);

        let width = Math.min(rect.width, availableWidth);
        if (width <= 0) {
            width = rect.width;
        }
        let left = rect.left + window.scrollX;
        const maxLeft = boundaryRight - width;
        if (left > maxLeft) {
            left = Math.max(maxLeft, boundaryLeft);
        }
        if (left < boundaryLeft) {
            left = boundaryLeft;
        }

        const verticalRoom = Math.max(0, boundaryBottom - boundaryTop);
        const maxHeight = verticalRoom > 0 ? Math.min(280, verticalRoom) : 280;
        let top = rect.bottom + window.scrollY + 4;

        if (dropdownHeight > 0 && top + dropdownHeight > boundaryBottom) {
            const openAbove = rect.top + window.scrollY - dropdownHeight - 4;
            if (openAbove >= boundaryTop) {
                top = openAbove;
            } else {
                top = Math.max(boundaryTop, boundaryBottom - dropdownHeight);
            }
        } else if (top < boundaryTop) {
            top = boundaryTop;
        }

        if (dropdownHeight > 0 && dropdownHeight > maxHeight && maxHeight > 0) {
            top = Math.min(top, boundaryBottom - maxHeight);
            top = Math.max(top, boundaryTop);
        }

        setDropdownStyle((prev) => {
            if (
                prev &&
                Math.abs(prev.top - top) < 0.5 &&
                Math.abs(prev.left - left) < 0.5 &&
                Math.abs(prev.width - width) < 0.5 &&
                Math.abs(prev.maxHeight - maxHeight) < 0.5
            ) {
                return prev;
            }
            return { top, left, width, maxHeight };
        });
    }, []);

    useEffect(() => {
        if (!open || disabled) {
            return;
        }

        updatePosition();

        function handleClickOutside(event: globalThis.MouseEvent) {
            const node = event.target instanceof Node ? event.target : null;
            if (containerRef.current && node && containerRef.current.contains(node)) return;
            if (dropdownRef.current && node && dropdownRef.current.contains(node)) return;
            setOpen(false);
        }

        function handleScroll(event: Event) {
            const target = event.target instanceof Node ? event.target : null;
            if (dropdownRef.current && target && dropdownRef.current.contains(target)) {
                return;
            }
            setOpen(false);
        }

        function handleResize() {
            updatePosition();
        }

        window.addEventListener('mousedown', handleClickOutside);
        window.addEventListener('scroll', handleScroll, true);
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('mousedown', handleClickOutside);
            window.removeEventListener('scroll', handleScroll, true);
            window.removeEventListener('resize', handleResize);
        };
    }, [open, disabled, updatePosition]);

    useEffect(() => {
        if (open) {
            setRenderDropdown(true);
            return;
        }
        if (renderDropdown) {
            const timeout = setTimeout(() => setRenderDropdown(false), 160);
            return () => clearTimeout(timeout);
        }
    }, [open, renderDropdown]);

    const handleToggle = () => {
        if (disabled) return;
        setOpen((prev) => !prev);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (disabled) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === ' ') {
            event.preventDefault();
            setOpen(true);
        }
    };

    const handleSelect = (option: CustomSelectOption) => {
        if (option.disabled) return;
        onChange(option.value);
        setOpen(false);
        buttonRef.current?.focus();
    };

    const dropdown = renderDropdown && dropdownStyle && !disabled ? createPortal(
        <div className="custom-select__dropdown-container">
            <ul
                ref={dropdownRef}
                className={classNames('custom-select__dropdown custom-dropdown-scrollbar', {
                    'custom-select__dropdown--open': open && !disabled,
                    'custom-select__dropdown--closing': !open,
                })}
                role="listbox"
                style={{
                    top: dropdownStyle.top,
                    left: dropdownStyle.left,
                    width: dropdownStyle.width,
                    maxHeight: dropdownStyle.maxHeight,
                }}
            >
                {options.map((option) => (
                    <li key={option.value}>
                        <button
                            type="button"
                            role="option"
                            aria-selected={selected?.value === option.value}
                            className={classNames('custom-select__option', {
                                'custom-select__option--selected': selected?.value === option.value,
                                'custom-select__option--disabled': Boolean(option.disabled),
                            })}
                            disabled={option.disabled}
                            onClick={() => handleSelect(option)}
                        >
                            <span>{option.label}</span>
                            {option.description ? <small>{option.description}</small> : null}
                        </button>
                    </li>
                ))}
            </ul>
        </div>,
        document.body,
    ) : null;

    return (
        <>
            <div
                ref={containerRef}
                className={classNames('custom-select', className, {
                    'custom-select--open': open,
                    'custom-select--disabled': disabled,
                })}
            >
                <button
                    ref={buttonRef}
                    type="button"
                    className="custom-select__trigger"
                    onClick={handleToggle}
                    onKeyDown={handleKeyDown}
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    disabled={disabled}
                >
                    <span className={classNames('custom-select__label', { 'custom-select__placeholder': !selected })}>
                        {selected ? selected.label : placeholder}
                    </span>
                    <span className="custom-select__chevron" aria-hidden />
                </button>
            </div>
            {dropdown}
        </>
    );
};

export default CustomSelect;
