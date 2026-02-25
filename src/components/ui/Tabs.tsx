import {
  createContext,
  useContext,
  useId,
  type ComponentProps,
  type KeyboardEvent,
} from 'react';

type TabsRootProps = ComponentProps<'div'> & {
  value: string;
  onValueChange: (nextValue: string) => void;
};

type TabsListProps = ComponentProps<'div'>;

type TabsTriggerProps = ComponentProps<'button'> & {
  value: string;
};

type TabsPanelProps = ComponentProps<'div'> & {
  value: string;
};

type TabsContextValue = {
  idBase: string;
  value: string;
  onValueChange: (nextValue: string) => void;
};

const TabsContext = createContext<TabsContextValue | null>(null);

function joinClassNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function toNodeId(prefix: string, value: string): string {
  return `${prefix}-${value.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
}

function useTabsContext(): TabsContextValue {
  const value = useContext(TabsContext);

  if (!value) {
    throw new Error('Tabs components must be rendered within <TabsRoot>.');
  }

  return value;
}

function moveFocusAndSelect(listNode: HTMLDivElement, nextIndex: number, onValueChange: (nextValue: string) => void) {
  const tabButtons = Array.from(listNode.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
  if (tabButtons.length === 0) {
    return;
  }

  const boundedIndex = Math.max(0, Math.min(nextIndex, tabButtons.length - 1));
  const target = tabButtons[boundedIndex];
  const targetValue = target.dataset.tabValue;

  target.focus();
  if (targetValue) {
    onValueChange(targetValue);
  }
}

function onListKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  selectedValue: string,
  onValueChange: (nextValue: string) => void,
) {
  const listNode = event.currentTarget;
  const tabButtons = Array.from(listNode.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
  if (tabButtons.length === 0) {
    return;
  }

  const activeElement = document.activeElement as HTMLElement | null;
  const focusedIndex = tabButtons.findIndex((button) => button === activeElement);
  const selectedIndex = tabButtons.findIndex((button) => button.dataset.tabValue === selectedValue);
  const currentIndex = focusedIndex >= 0 ? focusedIndex : Math.max(selectedIndex, 0);

  if (event.key === 'ArrowRight') {
    event.preventDefault();
    moveFocusAndSelect(listNode, (currentIndex + 1) % tabButtons.length, onValueChange);
    return;
  }

  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    moveFocusAndSelect(listNode, (currentIndex - 1 + tabButtons.length) % tabButtons.length, onValueChange);
    return;
  }

  if (event.key === 'Home') {
    event.preventDefault();
    moveFocusAndSelect(listNode, 0, onValueChange);
    return;
  }

  if (event.key === 'End') {
    event.preventDefault();
    moveFocusAndSelect(listNode, tabButtons.length - 1, onValueChange);
  }
}

export function TabsRoot({ value, onValueChange, children, ...props }: TabsRootProps) {
  const idBase = useId();

  return (
    <TabsContext.Provider value={{ idBase, value, onValueChange }}>
      <div {...props}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ onKeyDown, ...props }: TabsListProps) {
  const { value, onValueChange } = useTabsContext();

  return (
    <div
      role="tablist"
      onKeyDown={(event) => {
        onListKeyDown(event, value, onValueChange);
        onKeyDown?.(event);
      }}
      {...props}
    />
  );
}

export function TabsTrigger({ value, className, onClick, type, ...props }: TabsTriggerProps) {
  const { idBase, value: selectedValue, onValueChange } = useTabsContext();
  const isActive = selectedValue === value;
  const tabId = toNodeId(`${idBase}-tab`, value);
  const panelId = toNodeId(`${idBase}-panel`, value);

  return (
    <button
      type={type ?? 'button'}
      role="tab"
      id={tabId}
      aria-selected={isActive}
      aria-controls={panelId}
      tabIndex={isActive ? 0 : -1}
      data-tab-value={value}
      className={joinClassNames(className, isActive ? 'active' : undefined)}
      onClick={(event) => {
        onValueChange(value);
        onClick?.(event);
      }}
      {...props}
    />
  );
}

export function TabsPanel({ value, ...props }: TabsPanelProps) {
  const { idBase, value: selectedValue } = useTabsContext();
  const isActive = selectedValue === value;
  const tabId = toNodeId(`${idBase}-tab`, value);
  const panelId = toNodeId(`${idBase}-panel`, value);

  return <div role="tabpanel" id={panelId} aria-labelledby={tabId} hidden={!isActive} {...props} />;
}
