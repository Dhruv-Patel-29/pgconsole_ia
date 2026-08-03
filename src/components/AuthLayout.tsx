import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import AuthForm from './AuthForm';
import logoFull from '@/assets/logo-light-full.svg';

interface AuthLayoutProps {
  title: string;
  description: string;
}

export default function AuthLayout({ title, description }: AuthLayoutProps) {
  return (
    <div className="w-full max-w-md p-4">
      {/* The lockup does the naming here, so the heading below states the task instead of
          repeating the product name. Sized larger than the header's 30px because this screen
          has the room and is the one place the identity is the whole point. */}
      <div className="mb-6 flex justify-center">
        <img src={logoFull} alt="InfoAnalytica" className="h-9" />
      </div>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent>
          <AuthForm onSuccess={() => { window.location.href = '/' }} />
        </CardContent>
      </Card>
    </div>
  );
}
