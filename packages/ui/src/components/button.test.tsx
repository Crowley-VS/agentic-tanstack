// What Button renders on the server: its slot, variant classes, and asChild.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from './button';

describe('Button', () => {
  it('renders a button with its variant and size, and merges className last', () => {
    const html = renderToStaticMarkup(
      <Button variant="outline" size="sm" className="px-6">
        Save
      </Button>,
    );
    expect(html).toMatch(/^<button [^>]*data-slot="button"/);
    expect(html).toContain('data-variant="outline"');
    expect(html).toContain('data-size="sm"');
    expect(html).toContain('border-border');
    expect(html).toContain('px-6');
    expect(html).not.toMatch(/\spx-2\.5[\s"]/);
  });

  it('renders its child instead of a button with asChild', () => {
    const html = renderToStaticMarkup(
      <Button asChild>
        <a href="/notes">Notes</a>
      </Button>,
    );
    expect(html).toMatch(/^<a [^>]*href="\/notes"[^>]*data-slot="button"/);
  });
});
