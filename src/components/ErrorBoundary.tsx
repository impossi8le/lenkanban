"use client";

import React from "react";
import { isCancellationError } from "@/lib/telemetry/client";
import { reportRenderFailure } from "@/lib/telemetry/render-error";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorId: string | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorId: null };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true, errorId: null };
  }

  componentDidCatch(error: Error) {
    // An aborted request is not a crash: show the recovery UI without a
    // diagnostic reference and without counting it in either sink.
    if (isCancellationError(error)) return;
    this.setState({ errorId: reportRenderFailure(error) });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-4">
          <div className="w-full max-w-md space-y-4 text-center">
            <div className="space-y-2">
              <h1 className="text-3xl font-bold text-foreground">
                Что-то пошло не так
              </h1>
              <p className="text-muted-foreground">
                Произошла непредвиденная ошибка. Попробуйте перезагрузить страницу.
              </p>
            </div>

            {this.state.errorId && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-left">
                <p className="font-mono text-sm text-destructive">
                  Код ошибки: {this.state.errorId}
                </p>
              </div>
            )}

            <div className="flex gap-2 justify-center">
              <Button
                onClick={() => {
                  this.setState({ hasError: false, errorId: null });
                  window.location.href = "/";
                }}
              >
                Вернуться на главную
              </Button>
              <Button
                variant="outline"
                onClick={() => window.location.reload()}
              >
                Перезагрузить страницу
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
