import { render } from "@testing-library/react";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import React from "react";
import { MemoryRouter } from "react-router-dom";

function asDecoratorList(value: unknown): Decorator[] {
  if (!value) return [];
  if (Array.isArray(value)) return value as Decorator[];
  return [value as Decorator];
}

function applyDecorators(
  element: React.ReactNode,
  decorators: Decorator[],
  args: Record<string, unknown>,
) {
  const context = { args } as Parameters<Decorator>[1];
  return decorators.reduce<React.ReactNode>((acc, decorator) => {
    const Story = () => <>{acc}</>;
    return decorator(Story, context);
  }, element);
}

export function renderStory<C extends React.ComponentType<unknown>>(
  meta: Meta<C>,
  story: StoryObj<C>,
) {
  const mergedArgs = {
    ...(meta.args ?? {}),
    ...(story.args ?? {}),
  } as Record<string, unknown>;

  const Component = meta.component as
    | React.ComponentType<Record<string, unknown>>
    | undefined;

  let tree: React.ReactNode =
    typeof story.render === "function"
      ? story.render(mergedArgs as never, {} as never)
      : Component
        ? React.createElement(Component, mergedArgs)
        : null;

  tree = applyDecorators(
    tree,
    [
      ...asDecoratorList(meta.decorators),
      ...asDecoratorList(story.decorators),
    ],
    mergedArgs,
  );

  tree = (
    <MemoryRouter>
      <div className="dark min-w-[320px] bg-zinc-950 p-4 text-zinc-100">{tree}</div>
    </MemoryRouter>
  );

  return render(tree);
}
